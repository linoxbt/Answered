import WebSocket from 'ws'
import type { FastifyBaseLogger } from 'fastify'
import { AudioClock, BYTES_PER_SECOND, type Transcriber, type TranscriberFactory, type TranscriberHandlers, type TranscriptWord } from './types.js'

/**
 * Deepgram live transcription over a raw WebSocket (checked against the v1/listen reference,
 * 26 Nov 2026): Authorization: Token <key>; repeated `keyterm` params (Nova-3); KeepAlive every
 * 3-5 s, since 10 s without audio or KeepAlive closes the stream (NET-0001).
 */
export interface DeepgramOptions {
  apiKey: string
  log: FastifyBaseLogger
  url?: string
  model?: string
  /** Project names, tickers: improves recognition of words the model would not expect. */
  keyterms?: string[]
  /** Silence (ms) that marks the end of speech in a result (`speech_final`). */
  endpointingMs?: number
  /** Gap (ms) with no new words before an UtteranceEnd message. Docs: 1000 or more. */
  utteranceEndMs?: number
  now?: () => number
  /** Test seam; defaults to 4000 (docs: every 3-5 s). */
  keepAliveMs?: number
}

export function deepgramUrl(o: Pick<DeepgramOptions, 'url' | 'model' | 'keyterms' | 'endpointingMs' | 'utteranceEndMs'>): string {
  const params = new URLSearchParams({
    model: o.model ?? 'nova-3',
    language: 'en',
    smart_format: 'true',
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    interim_results: 'true', // required by utterance_end_ms
    endpointing: String(o.endpointingMs ?? 300),
    utterance_end_ms: String(o.utteranceEndMs ?? 1500),
    vad_events: 'true',
  })
  for (const term of o.keyterms ?? []) if (term.trim()) params.append('keyterm', term.trim())
  return `${o.url ?? 'wss://api.deepgram.com/v1/listen'}?${params}`
}

interface DeepgramWord {
  word: string
  punctuated_word?: string
  start: number
  end: number
  confidence: number
}

type DeepgramMessage =
  | {
      type: 'Results'
      start: number
      duration: number
      is_final: boolean
      speech_final: boolean
      channel: { alternatives: Array<{ transcript: string; words: DeepgramWord[] }> }
    }
  | { type: 'UtteranceEnd'; last_word_end: number }
  | { type: 'SpeechStarted' | 'Metadata' }
  | { type: 'Error'; variant?: string; description?: string; message?: string }

const KEEPALIVE_MS = 4000
/** Audio kept while (re)connecting, so the start of an answer is not lost. */
const BACKLOG_BYTES = 5 * BYTES_PER_SECOND
const MAX_BACKOFF_MS = 8000

class DeepgramTranscriber implements Transcriber {
  private ws?: WebSocket
  private clock: AudioClock
  private backlog: Buffer[] = []
  private backlogBytes = 0
  private lastAudioAt = 0
  private keepAlive?: ReturnType<typeof setInterval>
  private retry?: ReturnType<typeof setTimeout>
  private backoff = 500
  private closed = false
  private readonly now: () => number

  constructor(
    private readonly o: DeepgramOptions,
    private readonly h: TranscriberHandlers,
  ) {
    this.now = o.now ?? Date.now
    this.clock = new AudioClock(this.now)
    this.connect()
  }

  send(pcm: Buffer): void {
    if (this.closed) return
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.clock.push(pcm.length)
      this.ws.send(pcm)
      this.lastAudioAt = this.now()
      return
    }
    this.backlog.push(pcm)
    this.backlogBytes += pcm.length
    while (this.backlogBytes > BACKLOG_BYTES) this.backlogBytes -= this.backlog.shift()!.length
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retry)
    clearInterval(this.keepAlive)
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws?.terminate()
      return
    }
    // CloseStream flushes the last results before Deepgram closes the socket.
    ws.send(JSON.stringify({ type: 'CloseStream' }))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate()
        resolve()
      }, 3000)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private connect(): void {
    const ws = new WebSocket(deepgramUrl(this.o), { headers: { Authorization: `Token ${this.o.apiKey}` } })
    this.ws = ws

    ws.on('open', () => {
      this.backoff = 500
      // Deepgram's audio time restarts at 0 on every connection.
      this.clock = new AudioClock(this.now)
      for (const chunk of this.backlog) {
        this.clock.push(chunk.length)
        ws.send(chunk)
      }
      this.backlog = []
      this.backlogBytes = 0
      this.lastAudioAt = this.now()
      clearInterval(this.keepAlive)
      const every = this.o.keepAliveMs ?? KEEPALIVE_MS
      this.keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && this.now() - this.lastAudioAt >= every * 0.75) {
          ws.send(JSON.stringify({ type: 'KeepAlive' }))
        }
      }, every)
      this.o.log.info('deepgram stream open')
    })

    ws.on('message', (data, isBinary) => {
      if (isBinary) return
      try {
        this.handle(JSON.parse(data.toString()) as DeepgramMessage)
      } catch (err) {
        this.h.onError(err)
      }
    })

    // A refused handshake (bad key, no credit) will not fix itself by retrying.
    ws.on('unexpected-response', (_req, res) => {
      const fatal = res.statusCode === 401 || res.statusCode === 403 || res.statusCode === 402
      this.h.onError(new Error(`deepgram refused the stream: HTTP ${res.statusCode}`))
      ws.terminate()
      if (fatal) this.closed = true
    })

    ws.on('error', (err) => this.h.onError(err))

    ws.on('close', (code, reason) => {
      clearInterval(this.keepAlive)
      if (this.ws !== ws || this.closed) return
      this.o.log.warn({ code, reason: reason.toString() }, 'deepgram stream closed; reconnecting')
      this.retry = setTimeout(() => this.connect(), this.backoff)
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    })
  }

  private handle(msg: DeepgramMessage): void {
    switch (msg.type) {
      case 'Results': {
        const alt = msg.channel.alternatives[0]
        const text = alt?.transcript.trim() ?? ''
        if (!text) return
        if (!msg.is_final) return this.h.onEvent({ type: 'interim', text })
        const words: TranscriptWord[] = (alt?.words ?? []).map((w) => ({
          word: w.punctuated_word ?? w.word,
          startAt: this.clock.toWall(w.start),
          endAt: this.clock.toWall(w.end),
          confidence: w.confidence,
        }))
        return this.h.onEvent({
          type: 'final',
          text,
          startAt: this.clock.toWall(msg.start),
          endAt: this.clock.toWall(msg.start + msg.duration),
          words,
          speechFinal: msg.speech_final,
        })
      }
      case 'UtteranceEnd':
        return this.h.onEvent({ type: 'utterance_end', at: this.clock.toWall(msg.last_word_end) })
      case 'Error':
        return this.o.log.warn({ variant: msg.variant, description: msg.description ?? msg.message }, 'deepgram error message')
      default:
        return
    }
  }
}

export function deepgramFactory(o: DeepgramOptions): TranscriberFactory {
  return (handlers) => new DeepgramTranscriber(o, handlers)
}
