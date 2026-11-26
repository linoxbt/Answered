/** Speech-to-text, provider-neutral. Times are wall-clock milliseconds (see AudioClock). */

export interface TranscriptWord {
  word: string
  startAt: number
  endAt: number
  confidence: number
}

export type TranscriptEvent =
  /** Text that will not be revised. `speechFinal`: the speaker paused (endpointing). */
  | { type: 'final'; text: string; startAt: number; endAt: number; words: TranscriptWord[]; speechFinal: boolean }
  /** Provisional text, replaced by a later final; useful for a live "listening..." line. */
  | { type: 'interim'; text: string }
  /** No new words for the utterance gap (Deepgram's UtteranceEnd). */
  | { type: 'utterance_end'; at: number }

export interface TranscriberHandlers {
  onEvent(event: TranscriptEvent): void
  onError(err: unknown): void
}

/** One live speech-to-text stream for one session. */
export interface Transcriber {
  /** PCM s16le, 16 kHz, mono. */
  send(pcm: Buffer): void
  close(): Promise<void>
}

export type TranscriberFactory = (handlers: TranscriberHandlers) => Transcriber

/** PCM s16le 16 kHz mono = 32,000 bytes per second. */
export const BYTES_PER_SECOND = 32_000

/**
 * Maps the provider's audio time (seconds of audio it has received, which stops when the
 * glasses stop sending) to wall-clock time, using when each chunk was handed over.
 */
export class AudioClock {
  private readonly chunks: Array<{ audioStart: number; wall: number }> = []
  private audioSeconds = 0

  constructor(private readonly now: () => number = Date.now) {}

  get seconds(): number {
    return this.audioSeconds
  }

  push(bytes: number): void {
    this.chunks.push({ audioStart: this.audioSeconds, wall: this.now() })
    this.audioSeconds += bytes / BYTES_PER_SECOND
    // Two hours of 100 ms chunks; older words are never looked up.
    if (this.chunks.length > 72_000) this.chunks.splice(0, this.chunks.length - 72_000)
  }

  /** Wall-clock ms for an audio-time offset in seconds. */
  toWall(audioSeconds: number): number {
    const c = this.chunks
    if (!c.length) return this.now()
    let lo = 0
    let hi = c.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (c[mid]!.audioStart <= audioSeconds) lo = mid
      else hi = mid - 1
    }
    return Math.round(c[lo]!.wall + (audioSeconds - c[lo]!.audioStart) * 1000)
  }
}
