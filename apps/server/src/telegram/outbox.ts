/**
 * Everything the bot sends to a group goes through here.
 *
 * Telegram allows a bot about 20 messages per minute in one group. Answered keeps
 * one queue per chat: at most 1 call per second and 18 per rolling minute. Reactions
 * are not documented as exempt, so they share the same budget at low priority:
 * replies always go first and reactions fill the gaps. A 429 pauses the chat's queue
 * for `retry_after` seconds and retries the same call.
 */

export type Priority = 'high' | 'low'

export interface OutboxOptions {
  /** Minimum gap between two calls in one chat. */
  minGapMs?: number
  /** Max calls per chat in any rolling 60 s window. */
  perMinute?: number
  /** Attempts per job when Telegram answers 429. */
  maxAttempts?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onRateLimited?: (info: { chatId: number; label: string; retryAfterS: number }) => void
}

interface Job {
  run: () => Promise<unknown>
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  label: string
  attempts: number
}

interface ChatQueue {
  high: Job[]
  low: Job[]
  sentAt: number[]
  pausedUntil: number
  running: boolean
}

const WINDOW_MS = 60_000

/** Seconds to wait if `err` is a Telegram 429, else undefined. Works with grammY's GrammyError. */
export function retryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as { error_code?: number; parameters?: { retry_after?: number } }
  if (e.error_code !== 429) return undefined
  return e.parameters?.retry_after ?? 5
}

export class Outbox {
  private readonly chats = new Map<number, ChatQueue>()
  private readonly minGapMs: number
  private readonly perMinute: number
  private readonly maxAttempts: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: OutboxOptions = {}) {
    this.minGapMs = opts.minGapMs ?? 1000
    this.perMinute = opts.perMinute ?? 18
    this.maxAttempts = opts.maxAttempts ?? 5
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  /** Queues a Bot API call for `chatId` and resolves with its result once sent. */
  enqueue<T>(chatId: number, run: () => Promise<T>, opts: { priority?: Priority; label?: string } = {}): Promise<T> {
    const q = this.queue(chatId)
    return new Promise<T>((resolve, reject) => {
      const job: Job = { run, resolve: resolve as (v: unknown) => void, reject, label: opts.label ?? 'call', attempts: 0 }
      q[opts.priority ?? 'high'].push(job)
      void this.pump(chatId, q)
    })
  }

  pending(chatId: number): number {
    const q = this.chats.get(chatId)
    return q ? q.high.length + q.low.length : 0
  }

  /** Milliseconds until this chat may send again. */
  private waitMs(q: ChatQueue): number {
    const now = this.now()
    q.sentAt = q.sentAt.filter((t) => t > now - WINDOW_MS)
    let until = q.pausedUntil
    const last = q.sentAt.at(-1)
    if (last !== undefined) until = Math.max(until, last + this.minGapMs)
    if (q.sentAt.length >= this.perMinute) until = Math.max(until, q.sentAt[q.sentAt.length - this.perMinute]! + WINDOW_MS)
    return Math.max(0, until - now)
  }

  private async pump(chatId: number, q: ChatQueue): Promise<void> {
    if (q.running) return
    q.running = true
    try {
      while (q.high.length || q.low.length) {
        const wait = this.waitMs(q)
        if (wait > 0) {
          await this.sleep(wait)
          continue // a higher-priority job may have arrived while waiting
        }
        const lane = q.high.length ? q.high : q.low
        const job = lane.shift()!
        q.sentAt.push(this.now())
        job.attempts += 1
        try {
          job.resolve(await job.run())
        } catch (err) {
          const retryAfter = retryAfterSeconds(err)
          if (retryAfter !== undefined && job.attempts < this.maxAttempts) {
            q.pausedUntil = this.now() + retryAfter * 1000
            this.opts.onRateLimited?.({ chatId, label: job.label, retryAfterS: retryAfter })
            lane.unshift(job)
          } else {
            job.reject(err)
          }
        }
      }
    } finally {
      q.running = false
    }
  }

  private queue(chatId: number): ChatQueue {
    let q = this.chats.get(chatId)
    if (!q) {
      q = { high: [], low: [], sentAt: [], pausedUntil: 0, running: false }
      this.chats.set(chatId, q)
    }
    return q
  }
}
