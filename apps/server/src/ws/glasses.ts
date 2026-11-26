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
import { PairingCodes } from '../hosts.js'

/**
 * Who a pair of glasses belongs to: a paired host's id, or DEV for the setup token that the
 * test scripts (and phase 0-4 glasses) use, which follows whichever session is live.
 */
export type Viewer = string
export const DEV: Viewer = 'dev'

export interface GlassesConnectionStats {
  id: string
  viewer: Viewer | 'pairing'
  /** While pairing: the code on screen (dev stats only). */
  pairCode?: string
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
  /** Undefined while the glasses wait for `/pair <code>`. */
  viewer?: Viewer
  pairCode?: string
  stats: GlassesConnectionStats
  lastStatusText?: string
  statusTimer?: NodeJS.Timeout
  /** Replaces the pairing code before it expires. */
  pairTimer?: NodeJS.Timeout
}

export interface HubHooks {
  /** Every audio frame (PCM s16le 16 kHz mono) from a viewer's glasses. */
  audio?: (pcm: Buffer, viewer: Viewer) => void
  /** A gesture; return false to fall back to the default (double = exit). */
  input?: (g: Gesture, idx: number | undefined, viewer: Viewer) => boolean
  /** What a viewer should see right now (on connect and resume); undefined = diagnostic screen. */
  screenFor?: (viewer: Viewer) => Screen | undefined
}

/** How often the diagnostic screen may be redrawn. The BLE link to the glasses is slow. */
const STATUS_REFRESH_MS = 1000

export class GlassesHub {
  private readonly connections = new Map<string, Connection>()
  private readonly screens = new Map<Viewer, Screen>()
  private readonly pairing: PairingCodes<string>
  private readonly pairRefreshMs: number
  private totalAudioBytes = 0

  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly hooks: HubHooks = {},
    /** Pairing codes last this long; the glasses get a fresh one shortly before. */
    pairTtlMs = 10 * 60_000,
  ) {
    this.pairing = new PairingCodes<string>(pairTtlMs)
    this.pairRefreshMs = Math.max(pairTtlMs - 30_000, pairTtlMs / 2)
  }

  get size(): number {
    return this.connections.size
  }

  stats() {
    return {
      connections: [...this.connections.values()].map((c) => c.stats),
      totalAudioBytes: this.totalAudioBytes,
      screen: this.screens.get(DEV)?.view ?? 'status',
    }
  }

  /** Shows a screen to these viewers' glasses (and remembers it for glasses that connect later). */
  show(screen: Screen, viewers: Viewer[]): void {
    for (const v of new Set(viewers)) {
      this.screens.set(v, screen)
      for (const conn of this.connections.values()) if (conn.viewer === v) this.render(conn)
    }
  }

  /** Sends a control message to a viewer's glasses. */
  sendTo(viewer: Viewer, msg: ServerMessage): void {
    for (const conn of this.connections.values()) if (conn.viewer === viewer) this.send(conn, msg)
  }

  /** True if glasses are on screen with this pairing code. */
  pairingWaiting(code: string): boolean {
    return this.pairing.has(code)
  }

  /**
   * Completes pairing for the glasses showing `code`. They receive their token and reconnect with it.
   * Returns false if no glasses are waiting with that code.
   */
  completePairing(code: string, token: string, group: string): boolean {
    const connId = this.pairing.claim(code)
    const conn = connId ? this.connections.get(connId) : undefined
    if (!conn) return false
    this.send(conn, { t: 'paired', token, group })
    conn.socket.close(1000, 'paired')
    return true
  }

  /** The viewer's glasses forget their token and go back to the pairing screen. */
  unpair(viewer: Viewer): void {
    this.screens.delete(viewer)
    for (const conn of this.connections.values()) {
      if (conn.viewer !== viewer) continue
      this.send(conn, { t: 'unpaired' })
      conn.socket.close(1000, 'unpaired')
    }
  }

  private render(conn: Connection): void {
    if (!conn.viewer) {
      if (conn.pairCode) this.send(conn, { t: 'screen', view: 'pair', code: conn.pairCode })
      return
    }
    const screen = this.screens.get(conn.viewer) ?? this.hooks.screenFor?.(conn.viewer)
    if (screen) {
      this.screens.set(conn.viewer, screen)
      conn.lastStatusText = undefined
      this.send(conn, { t: 'screen', ...screen })
    } else {
      this.pushStatus(conn)
    }
  }

  /** `viewer` undefined: the glasses are not paired yet and get a pairing code. */
  attach(socket: WebSocket, viewer: Viewer | undefined): void {
    const conn: Connection = {
      socket,
      viewer,
      stats: {
        id: randomUUID(),
        viewer: viewer ?? 'pairing',
        connectedAt: new Date().toISOString(),
        audioFrames: 0,
        audioBytes: 0,
        audioLevel: 0,
        inputs: 0,
      },
    }
    this.connections.set(conn.stats.id, conn)
    const log = this.log.child({ glasses: conn.stats.id, viewer: conn.stats.viewer })
    log.info('glasses connected')

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (isBinary) this.onAudio(conn, data)
      else this.onJson(conn, data.toString(), log)
    })
    socket.on('close', (code) => {
      clearTimeout(conn.statusTimer)
      clearInterval(conn.pairTimer)
      if (conn.pairCode) this.pairing.release(conn.pairCode)
      this.connections.delete(conn.stats.id)
      log.info({ code, audioBytes: conn.stats.audioBytes, inputs: conn.stats.inputs }, 'glasses disconnected')
    })
    socket.on('error', (err) => log.warn({ err }, 'glasses socket error'))

    if (!viewer) {
      conn.pairCode = this.pairing.create(conn.stats.id)
      conn.stats.pairCode = conn.pairCode
      // Glasses can sit on the pairing screen for a long time: the code on screen stays the same and
      // stays valid while they are connected (it expires 10 minutes after they disconnect).
      conn.pairTimer = setInterval(() => {
        if (conn.pairCode && this.pairing.renew(conn.pairCode)) return
        conn.pairCode = this.pairing.create(conn.stats.id)
        conn.stats.pairCode = conn.pairCode
        this.render(conn)
      }, this.pairRefreshMs)
      log.info('glasses waiting to pair')
    }
    this.render(conn)
  }

  private onAudio(conn: Connection, data: RawData): void {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer)
    conn.stats.audioFrames += 1
    conn.stats.audioBytes += buf.length
    conn.stats.audioLevel = peakLevel(buf)
    this.totalAudioBytes += buf.length
    if (!conn.viewer) return // unpaired glasses have no session to hear
    this.hooks.audio?.(buf, conn.viewer)
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
        // The mic stays on while connected: hosts often start answering before they press.
        if (conn.viewer) this.send(conn, { t: 'audio', on: true, source: msg.mic })
        this.render(conn)
        return
      case 'input':
        conn.stats.inputs += 1
        conn.stats.lastInput = { g: msg.g, src: msg.src, idx: msg.idx, at: new Date().toISOString() }
        log.info({ g: msg.g, src: msg.src, idx: msg.idx }, 'glasses input')
        if (conn.viewer && this.hooks.input?.(msg.g, msg.idx, conn.viewer)) return
        // Double-tap is the platform's "exit app" gesture.
        if (msg.g === 'double') this.send(conn, { t: 'exit' })
        else if (conn.viewer && !this.screens.has(conn.viewer)) this.pushStatus(conn)
        return
      case 'resume':
        log.info('glasses resumed')
        if (conn.viewer) this.send(conn, { t: 'audio', on: true, source: conn.stats.mic ?? 'glasses' })
        conn.lastStatusText = undefined
        this.render(conn)
        return
    }
  }

  private scheduleStatus(conn: Connection): void {
    if (conn.statusTimer) return
    conn.statusTimer = setTimeout(() => {
      conn.statusTimer = undefined
      if (conn.viewer && !this.screens.has(conn.viewer)) this.pushStatus(conn)
    }, STATUS_REFRESH_MS)
  }

  /** Diagnostic screen for the dev token: proves audio and input both reach the server. */
  private pushStatus(conn: Connection): void {
    const s = conn.stats
    const last = s.lastInput ? `${s.lastInput.g}${s.lastInput.src ? ` (${s.lastInput.src})` : ''}` : '-'
    const lines = [
      `Mic: ${s.mic ?? '?'} | ${(s.audioBytes / 1024).toFixed(0)} KB | level ${s.audioLevel}%`,
      `Last input: ${last} | total ${s.inputs}`,
      'No live session. Double-tap to exit',
    ]
    const text = lines.join('\n')
    if (text === conn.lastStatusText) return
    conn.lastStatusText = text
    this.send(conn, { t: 'screen', view: 'status', title: 'ANSWERED', lines })
  }

  private send(conn: Connection, msg: ServerMessage): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(JSON.stringify(msg))
  }

  closeAll(): void {
    for (const c of this.connections.values()) {
      clearInterval(c.pairTimer)
      c.socket.close(1001, 'server shutting down')
    }
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

export function tokenMatches(expected: string | undefined, received: unknown): boolean {
  if (!expected || typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

export interface GlassesRouteOptions {
  hub: GlassesHub
  devToken: string | undefined
  /** Looks up a paired host's id by token. */
  hostByToken: (token: string) => string | undefined
}

export async function glassesRoutes(app: FastifyInstance, opts: GlassesRouteOptions): Promise<void> {
  // No token: pairing. Dev token: the scripts. Host token: that host's glasses. Anything else: 4401.
  app.get('/ws/glasses', { websocket: true }, (socket, req) => {
    const token = (req.query as Record<string, unknown>).token
    if (typeof token !== 'string' || token === '') return opts.hub.attach(socket, undefined)
    if (tokenMatches(opts.devToken, token)) return opts.hub.attach(socket, DEV)
    const host = opts.hostByToken(token)
    if (host) return opts.hub.attach(socket, host)
    socket.close(4401, 'unauthorized')
  })

  // Diagnostic counters; needs the dev token.
  app.get('/debug/stats', async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (!tokenMatches(opts.devToken, token)) return reply.code(401).send({ error: 'unauthorized' })
    return opts.hub.stats()
  })
}
