import type { FastifyBaseLogger } from 'fastify'
import type { Screen } from '@answered/protocol'
import type { SessionService } from '../sessions.js'
import type { Classifier } from './classifier.js'
import type { ClusterStore } from './clusters.js'
import { mightBeQuestion } from './text.js'

export interface PipelineOptions {
  classifier: Classifier
  store: ClusterStore
  sessions: SessionService
  log: FastifyBaseLogger
  /** Called whenever a session's queue may have changed. */
  onQueueChanged: (sessionId: string) => void
  /** Spec: classify in batches every 2 s. */
  batchMs?: number
  maxBatch?: number
}

/**
 * Detect -> cluster for each live session. Captured messages wait up to `batchMs`, then go to
 * the classifier in one batch. One batch per session runs at a time; messages that arrive
 * meanwhile form the next batch.
 */
export class Pipeline {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly batchMs: number
  private readonly maxBatch: number

  constructor(private readonly o: PipelineOptions) {
    this.batchMs = o.batchMs ?? 2000
    // Measured: 10 per call keeps merges at 100% on the fixtures; one 30-message call drops to ~77%.
    this.maxBatch = o.maxBatch ?? 10
  }

  /** A message was stored for this session. */
  captured(sessionId: string): void {
    this.schedule(sessionId)
  }

  /** A captured message was edited: it leaves its cluster and is classified again. */
  edited(sessionId: string, chatId: number, messageId: number): void {
    if (this.o.store.detach(chatId, messageId)) this.o.onQueueChanged(sessionId)
    this.schedule(sessionId)
  }

  /** Runs any waiting batch now and resolves when the session has nothing pending (tests, /end). */
  async flush(sessionId: string): Promise<void> {
    clearTimeout(this.timers.get(sessionId))
    this.timers.delete(sessionId)
    await this.running.get(sessionId)
    await this.run(sessionId)
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private schedule(sessionId: string): void {
    if (this.timers.has(sessionId)) return
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId)
        void this.run(sessionId)
      }, this.batchMs),
    )
  }

  private run(sessionId: string): Promise<void> {
    const current = this.running.get(sessionId)
    if (current) {
      // A batch is in flight; pick up whatever arrived once it finishes.
      return current.then(() => this.schedule(sessionId))
    }
    const job = this.drain(sessionId).finally(() => this.running.delete(sessionId))
    this.running.set(sessionId, job)
    return job
  }

  private async drain(sessionId: string): Promise<void> {
    const { store, sessions, classifier, log } = this.o
    for (;;) {
      const session = sessions.get(sessionId)
      if (!session || session.status !== 'live') return
      const batch = store.pending(sessionId, this.maxBatch)
      if (!batch.length) return

      const candidates = batch.filter((m) => mightBeQuestion(m.text))
      const rejected = batch.filter((m) => !mightBeQuestion(m.text))
      if (rejected.length) store.markNotQuestion(session.chatId, rejected.map((m) => m.messageId))
      if (!candidates.length) continue

      const started = Date.now()
      let results
      try {
        results = await classifier.classify({
          messages: candidates.map((m) => ({ id: m.messageId, text: m.text, isReply: m.isReply })),
          clusters: store.assignable(sessionId),
        })
      } catch (err) {
        // Even the fallback failed: park these as non-questions rather than retrying forever.
        log.error({ err, session: sessionId }, 'classification failed')
        store.markNotQuestion(session.chatId, candidates.map((m) => m.messageId))
        continue
      }

      // The session may have ended while the model was thinking.
      const still = sessions.get(sessionId)
      if (!still || still.status !== 'live') return
      const touched = store.apply(sessionId, still.chatId, results)
      // Anything the classifier left out would otherwise come back in every batch.
      const covered = new Set(results.map((r) => r.messageId))
      const skipped = candidates.filter((m) => !covered.has(m.messageId)).map((m) => m.messageId)
      if (skipped.length) store.markNotQuestion(still.chatId, skipped)
      log.info(
        { session: sessionId, batch: batch.length, candidates: candidates.length, questions: results.filter((r) => r.isQuestion && !r.spam).length, clusters: touched.length, ms: Date.now() - started, classifier: classifier.name },
        'batch classified',
      )
      if (touched.length) this.o.onQueueChanged(sessionId)
    }
  }
}

export interface QueuePublisherOptions {
  store: ClusterStore
  sessions: SessionService
  show: (screen: Screen) => void
  now?: () => number
  /** Spec: list rebuilds flicker, so at most one every 5 s. */
  minGapMs?: number
  items?: number
}

/** Elapsed session time for the queue header: MM:SS, or H:MM:SS after an hour. */
export function sessionClock(startedAt: number | null, now: number): string {
  const s = Math.max(0, Math.floor((now - (startedAt ?? now)) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

/**
 * Pushes the top questions to the glasses only when the order or the counts change,
 * and never more often than once every `minGapMs`.
 */
export class QueuePublisher {
  private readonly last = new Map<string, { at: number; signature: string }>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private readonly minGapMs: number
  private readonly items: number

  constructor(private readonly o: QueuePublisherOptions) {
    this.now = o.now ?? Date.now
    this.minGapMs = o.minGapMs ?? 5000
    this.items = o.items ?? 5
  }

  /** The queue for this session may have changed. */
  changed(sessionId: string): void {
    if (this.timers.has(sessionId)) return
    const last = this.last.get(sessionId)
    const wait = last ? last.at + this.minGapMs - this.now() : 0
    if (wait <= 0) return this.publish(sessionId)
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId)
        this.publish(sessionId)
      }, wait),
    )
  }

  /** Shows the queue straight away (session start, resume) regardless of throttling. */
  publishNow(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId))
    this.timers.delete(sessionId)
    this.last.delete(sessionId)
    this.publish(sessionId)
  }

  forget(sessionId: string): void {
    clearTimeout(this.timers.get(sessionId))
    this.timers.delete(sessionId)
    this.last.delete(sessionId)
  }

  screen(sessionId: string): Screen | undefined {
    const session = this.o.sessions.get(sessionId)
    if (!session || session.status !== 'live') return undefined
    const ranked = this.o.store.ranked(sessionId)
    return {
      view: 'queue',
      clock: sessionClock(session.startedAt, this.now()),
      open: ranked.length,
      items: ranked.slice(0, this.items).map((c) => ({ id: c.id, n: c.askers, title: c.title })),
      group: session.chatTitle,
    }
  }

  private publish(sessionId: string): void {
    const screen = this.screen(sessionId)
    if (!screen || screen.view !== 'queue') return
    // The clock is left out of the signature: it alone is no reason to rebuild the list.
    const signature = JSON.stringify([screen.open, screen.items])
    const last = this.last.get(sessionId)
    if (last?.signature === signature) return
    this.last.set(sessionId, { at: this.now(), signature })
    this.o.show(screen)
  }
}
