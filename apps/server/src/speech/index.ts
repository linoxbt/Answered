import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../db/index.js'
import type { Session, SessionService } from '../sessions.js'
import type { Transcriber, TranscriberFactory, TranscriptEvent } from './types.js'

export interface Segment {
  sessionId: string
  /** Seconds since the session went live. */
  startS: number
  endS: number
  text: string
}

export type SpeechEvent =
  | { type: 'segment'; segment: Segment; speechFinal: boolean }
  /** The host stopped talking: the moment the answer matcher (phase 4) runs. */
  | { type: 'utterance_end'; sessionId: string; atS: number }
  | { type: 'interim'; sessionId: string; text: string }

export interface SpeechOptions {
  db: Db
  sessions: SessionService
  log: FastifyBaseLogger
  /** Undefined when no speech provider is configured: audio is then dropped. */
  factory?: TranscriberFactory
  /** Close a session's stream after this long without audio (stops paying for an idle stream). */
  idleMs?: number
  now?: () => number
}

interface Stream {
  session: Session
  transcriber: Transcriber
  lastAudioAt: number
}

/**
 * Glasses audio -> speech-to-text -> transcript segments for the live session.
 * Audio is never stored; segments are deleted when the session ends.
 */
export class SpeechService {
  private readonly streams = new Map<string, Stream>()
  private readonly listeners = new Set<(e: SpeechEvent) => void>()
  private readonly idleTimer: ReturnType<typeof setInterval>
  private readonly now: () => number
  private warnedDisabled = false

  constructor(private readonly o: SpeechOptions) {
    this.now = o.now ?? Date.now
    const idleMs = o.idleMs ?? 60_000
    this.idleTimer = setInterval(() => {
      for (const [id, s] of this.streams) if (this.now() - s.lastAudioAt > idleMs) void this.stop(id, 'idle')
    }, Math.min(idleMs, 15_000))
    this.idleTimer.unref()
    o.sessions.onEvent((e) => {
      if (e.type === 'ended') void this.stop(e.session.id, 'session ended')
    })
  }

  get enabled(): boolean {
    return Boolean(this.o.factory)
  }

  onEvent(fn: (e: SpeechEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Audio from the glasses. Until pairing (phase 5) ties glasses to a host, it belongs to the
   * most recently started live session; with no live session it is dropped.
   */
  audio(pcm: Buffer): void {
    const session = this.activeSession()
    if (!session) return
    if (!this.o.factory) {
      if (!this.warnedDisabled) this.o.log.warn('DEEPGRAM_API_KEY not set: glasses audio is not transcribed')
      this.warnedDisabled = true
      return
    }
    let stream = this.streams.get(session.id)
    if (!stream) {
      stream = { session, transcriber: this.open(session), lastAudioAt: this.now() }
      this.streams.set(session.id, stream)
    }
    stream.lastAudioAt = this.now()
    stream.transcriber.send(pcm)
  }

  /** Final transcript of a session since `sinceS`, in order. */
  segments(sessionId: string, sinceS = 0): Segment[] {
    const rows = this.o.db
      .prepare('SELECT start_s, end_s, text FROM segments WHERE session_id = ? AND end_s >= ? ORDER BY start_s')
      .all(sessionId, sinceS) as Array<{ start_s: number; end_s: number; text: string }>
    return rows.map((r) => ({ sessionId, startS: r.start_s, endS: r.end_s, text: r.text }))
  }

  /** Seconds since the session went live, for a wall-clock time. */
  offset(session: Session, at: number): number {
    return Math.max(0, (at - (session.startedAt ?? at)) / 1000)
  }

  async stop(sessionId: string, why: string): Promise<void> {
    const stream = this.streams.get(sessionId)
    if (!stream) return
    this.streams.delete(sessionId)
    this.o.log.info({ session: sessionId, why }, 'speech stream closed')
    await stream.transcriber.close()
  }

  async close(): Promise<void> {
    clearInterval(this.idleTimer)
    await Promise.all([...this.streams.keys()].map((id) => this.stop(id, 'shutdown')))
  }

  private activeSession(): Session | undefined {
    return this.o.sessions.active()
  }

  private open(session: Session): Transcriber {
    this.o.log.info({ session: session.id }, 'speech stream opening')
    return this.o.factory!({
      onEvent: (e) => this.handle(session, e),
      onError: (err) => this.o.log.warn({ err, session: session.id }, 'speech stream error'),
    })
  }

  private handle(session: Session, e: TranscriptEvent): void {
    switch (e.type) {
      case 'final': {
        // The session may have ended (and its segments been deleted) while Deepgram was flushing.
        if (this.o.sessions.get(session.id)?.status !== 'live') return
        const segment: Segment = {
          sessionId: session.id,
          startS: round(this.offset(session, e.startAt)),
          endS: round(this.offset(session, e.endAt)),
          text: e.text,
        }
        this.o.db
          .prepare('INSERT INTO segments (session_id, start_s, end_s, text) VALUES (?, ?, ?, ?)')
          .run(segment.sessionId, segment.startS, segment.endS, segment.text)
        return this.emit({ type: 'segment', segment, speechFinal: e.speechFinal })
      }
      case 'utterance_end':
        return this.emit({ type: 'utterance_end', sessionId: session.id, atS: round(this.offset(session, e.at)) })
      case 'interim':
        return this.emit({ type: 'interim', sessionId: session.id, text: e.text })
    }
  }

  private emit(e: SpeechEvent): void {
    for (const fn of this.listeners) fn(e)
  }
}

const round = (s: number) => Math.round(s * 100) / 100
