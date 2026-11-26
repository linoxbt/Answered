import type { ClientMessage, ServerMessage } from '@answered/protocol'

export type ConnectionState = 'connecting' | 'open' | 'closed' | 'unauthorized'

export interface ConnectionEvents {
  onMessage(msg: ServerMessage): void
  onState(state: ConnectionState): void
  /** Called on every (re)connect, before any queued work; use it to send `hello`. */
  onOpen(): void
}

const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8000

/**
 * WebSocket to the Answered server with automatic reconnect.
 * Audio frames sent while the socket is down are dropped: stale audio is useless.
 */
export class ServerConnection {
  private ws?: WebSocket
  private backoff = MIN_BACKOFF_MS
  private retryTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  state: ConnectionState = 'closed'
  audioBytesSent = 0

  constructor(
    private url: string,
    private readonly events: ConnectionEvents,
  ) {}

  /** Use a different URL (new token) from the next connection on. */
  setUrl(url: string): void {
    this.url = url
  }

  /** Drops the current socket and connects again straight away (e.g. after pairing). */
  restart(): void {
    const ws = this.ws
    this.ws = undefined
    ws?.close(1000, 'restart')
    this.backoff = MIN_BACKOFF_MS
    this.connect()
  }

  connect(): void {
    this.stopped = false
    clearTimeout(this.retryTimer)
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return

    this.setState('connecting')
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.onopen = () => {
      this.backoff = MIN_BACKOFF_MS
      this.setState('open')
      this.events.onOpen()
    }
    ws.onmessage = (m) => {
      if (typeof m.data !== 'string') return
      try {
        this.events.onMessage(JSON.parse(m.data) as ServerMessage)
      } catch (err) {
        console.warn('bad server message', err)
      }
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      this.ws = undefined
      if (e.code === 4401) {
        // Wrong or missing token: retrying will not help.
        this.setState('unauthorized')
        return
      }
      this.setState('closed')
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose follows and handles the retry.
    }
  }

  /** Reconnect now if the socket died while the WebView was in the background. */
  ensureConnected(): void {
    if (this.state !== 'open' && this.state !== 'unauthorized') {
      this.backoff = MIN_BACKOFF_MS
      this.connect()
    }
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  sendAudio(pcm: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    // Copy so a view into a larger buffer never sends extra bytes.
    this.ws.send(pcm.slice())
    this.audioBytesSent += pcm.byteLength
  }

  close(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.ws?.close(1000, 'app closing')
  }

  private scheduleReconnect(): void {
    if (this.stopped) return
    const delay = this.backoff
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
    this.retryTimer = setTimeout(() => this.connect(), delay)
  }

  private setState(state: ConnectionState): void {
    this.state = state
    this.events.onState(state)
  }
}
