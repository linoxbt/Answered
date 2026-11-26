import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyBaseLogger } from 'fastify'
import type { WebSocket, RawData } from 'ws'
import {
  parseClientMessage,
  type ClientMessage,
  type Gesture,
  type InputSource,
  type MicSource,
  type Screen,
  type ServerMessage,
} from '@answered/protocol'

export interface GlassesConnectionStats {
  id: string
  connectedAt: string
  app?: string
  version?: string
  mic?: MicSource
  audioFrames: number
  audioBytes: number
  /** Peak level of the most recent frame, 0-100 (tells speech from silence). */
  audioLevel: number
  inputs: number
  lastInput?: { g: Gesture; src?: InputSource; idx?: number; at: string }
}

interface Connection {
  socket: WebSocket
  stats: GlassesConnectionStats
  lastStatusText?: string
  statusTimer?: NodeJS.Timeout
}

/** How often the phase-0 status screen may be redrawn. The BLE link to the glasses is slow. */
const STATUS_REFRESH_MS = 1000

export class GlassesHub {
  private readonly connections = new Map<string, Connection>()
  private totalAudioBytes = 0
  /** What every pair of glasses should show. Undefined = the phase-0 diagnostic screen. */
  private screen?: Screen

  constructor(
    private readonly log: FastifyBaseLogger,
    /** Receives every audio frame (PCM s16le 16 kHz mono) for speech-to-text. */
    private readonly audioSink: (pcm: Buffer) => void = () => {},
    /** Gestures for the live session; returns false to fall back to the default (double = exit). */
    private readonly inputSink: (g: Gesture, idx?: number) => boolean = () => false,
  ) {}

  get size(): number {
    return this.connections.size
  }

  stats() {
    return {
      connections: [...this.connections.values()].map((c) => c.stats),
      totalAudioBytes: this.totalAudioBytes,
      screen: this.screen?.view ?? 'status',
    }
  }

  /**
   * Shows a screen on every connected pair of glasses and on any that connect later.
   * Until pairing (phase 5) ties glasses to a host, all glasses belong to the one dev host.
   * Pass undefined to go back to the diagnostic screen.
   */
  show(screen: Screen | undefined): void {
    this.screen = screen
    for (const conn of this.connections.values()) this.render(conn)
  }

  private render(conn: Connection): void {
    if (this.screen) {
      conn.lastStatusText = undefined
      this.send(conn, { t: 'screen', ...this.screen })
    } else {
      this.pushStatus(conn)
    }
  }

  attach(socket: WebSocket): void {
    const conn: Connection = {
      socket,
      stats: {
        id: randomUUID(),
        connectedAt: new Date().toISOString(),
        audioFrames: 0,
        audioBytes: 0,
        audioLevel: 0,
        inputs: 0,
      },
    }
    this.connections.set(conn.stats.id, conn)
    const log = this.log.child({ glasses: conn.stats.id })
    log.info('glasses connected')

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) this.onAudio(conn, data)
      else this.onJson(conn, data.toString(), log)
    })
    socket.on('close', (code) => {
      clearTimeout(conn.statusTimer)
      this.connections.delete(conn.stats.id)
      log.info({ code, audioBytes: conn.stats.audioBytes, inputs: conn.stats.inputs }, 'glasses disconnected')
    })
    socket.on('error', (err) => log.warn({ err }, 'glasses socket error'))

    this.send(conn, { t: 'screen', view: 'status', title: 'ANSWERED', lines: ['Connected to server', 'Waiting for hello...'] })
  }

  private onAudio(conn: Connection, data: RawData): void {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    conn.stats.audioFrames += 1
    conn.stats.audioBytes += buf.length
    conn.stats.audioLevel = peakLevel(buf)
    this.totalAudioBytes += buf.length
    this.audioSink(buf)
    this.scheduleStatus(conn)
  }

  private onJson(conn: Connection, raw: string, log: FastifyBaseLogger): void {
    const msg = parseClientMessage(raw)
    if (!msg) {
      log.warn({ raw: raw.slice(0, 200) }, 'unrecognised glasses message')
      return
    }
    this.handle(conn, msg, log)
  }

  private handle(conn: Connection, msg: ClientMessage, log: FastifyBaseLogger): void {
    switch (msg.t) {
      case 'hello':
        Object.assign(conn.stats, { app: msg.app, version: msg.version, mic: msg.mic })
        log.info({ app: msg.app, version: msg.version, mic: msg.mic }, 'glasses hello')
        // Phase 0: turn the mic on straight away to prove audio reaches the server.
        this.send(conn, { t: 'audio', on: true, source: msg.mic })
        this.render(conn)
        return
      case 'input':
        conn.stats.inputs += 1
        conn.stats.lastInput = { g: msg.g, src: msg.src, idx: msg.idx, at: new Date().toISOString() }
        log.info({ g: msg.g, src: msg.src, idx: msg.idx }, 'glasses input')
        if (this.inputSink(msg.g, msg.idx)) return
        // Double-tap is the platform's "exit app" gesture.
        if (msg.g === 'double') this.send(conn, { t: 'exit' })
        else if (!this.screen) this.pushStatus(conn)
        return
      case 'resume':
        log.info('glasses resumed')
        this.send(conn, { t: 'audio', on: true, source: conn.stats.mic ?? 'glasses' })
        conn.lastStatusText = undefined
        this.render(conn)
        return
    }
  }

  private scheduleStatus(conn: Connection): void {
    if (conn.statusTimer) return
    conn.statusTimer = setTimeout(() => {
      conn.statusTimer = undefined
      if (!this.screen) this.pushStatus(conn)
    }, STATUS_REFRESH_MS)
  }

  /** Phase-0 diagnostic screen: proves audio and input both reach the server. */
  private pushStatus(conn: Connection): void {
    const s = conn.stats
    const last = s.lastInput ? `${s.lastInput.g}${s.lastInput.src ? ` (${s.lastInput.src})` : ''}` : '-'
    const lines = [
      `Mic: ${s.mic ?? '?'} | ${(s.audioBytes / 1024).toFixed(0)} KB | level ${s.audioLevel}%`,
      `Last input: ${last} | total ${s.inputs}`,
      'Double-tap to exit',
    ]
    const text = lines.join('\n')
    if (text === conn.lastStatusText) return
    conn.lastStatusText = text
    this.send(conn, { t: 'screen', view: 'status', title: 'ANSWERED  phase 0', lines })
  }

  private send(conn: Connection, msg: ServerMessage): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(msg))
  }

  closeAll(): void {
    for (const c of this.connections.values()) c.socket.close(1001, 'server shutting down')
  }
}

/** Peak absolute sample of s16le PCM as a percentage of full scale. */
export function peakLevel(pcm: Buffer): number {
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i))
    if (v > peak) peak = v
  }
  return Math.round((peak / 32768) * 100)
}

function tokenMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface GlassesRouteOptions {
  hub: GlassesHub
  devToken: string | undefined
}

export async function glassesRoutes(app: FastifyInstance, opts: GlassesRouteOptions): Promise<void> {
  app.get('/ws/glasses', { websocket: true }, (socket, req) => {
    const token = (req.query as Record<string, unknown>).token
    if (!opts.devToken || !tokenMatches(opts.devToken, token)) {
      socket.close(4401, 'unauthorized')
      return
    }
    opts.hub.attach(socket)
  })

  // Diagnostic counters for the day-1 risk checks; needs the same token as the socket.
  app.get('/debug/stats', async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!opts.devToken || !tokenMatches(opts.devToken, token)) return reply.code(401).send({ error: 'unauthorized' })
    return opts.hub.stats()
  })
}
