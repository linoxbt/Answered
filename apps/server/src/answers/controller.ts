import type { FastifyBaseLogger } from 'fastify'
import type { Gesture, Screen } from '@answered/protocol'
import type { ClusterStore } from '../pipeline/clusters.js'
import type { QueuePublisher } from '../pipeline/index.js'
import type { Session, SessionService } from '../sessions.js'
import type { SpeechService } from '../speech/index.js'
import { DEV, type Viewer } from '../ws/glasses.js'
import { rejection, type Judge, type JudgeQuestion, type Verdict } from './judge.js'
import type { AnswerWriter } from './writer.js'

/** An answer ready to post once the undo window passes. */
interface Pending {
  clusterId: string
  title: string
  askers: number
  summary: string
  quote: string
  offsetS: number
  manual: boolean
}

type Mode =
  | { kind: 'queue'; selected: number }
  | { kind: 'taking'; clusterId: string; takenS: number }
  | {
      kind: 'sending'
      clusterId: string
      takenS: number
      batch: Pending[]
      deadline: number
      timer: ReturnType<typeof setInterval>
      /** Wall-clock end of the speech that was judged (for the latency metric); undefined for manual. */
      speechEndAt?: number
    }
  | { kind: 'flash'; next: Mode; timer: ReturnType<typeof setTimeout> }
  | { kind: 'confirm_end' }

export interface ControllerOptions {
  sessions: SessionService
  store: ClusterStore
  publisher: QueuePublisher
  speech: SpeechService
  writer: AnswerWriter
  judge?: Judge
  /** Shows a screen on the glasses of everyone hosting this session. */
  show: (sessionId: string, screen: Screen) => void
  /** The session a viewer's gestures act on (their group's live session). */
  sessionFor: (viewer: Viewer) => Session | undefined
  /** What the glasses do when their group has no live session. */
  lobby?: {
    goLive: (viewer: Viewer) => void
    unpair: (viewer: Viewer) => void
    showLobby: (viewer: Viewer) => void
  }
  endSession: (session: Session) => void
  flagSpam: (session: Session, clusterId: string) => void
  log: FastifyBaseLogger
  now?: () => number
  /** Undo window before an answer is posted (press = send now, swipe = cancel). */
  undoMs?: number
  /** How long "[OK] Sent" and "Still open" stay up. */
  flashMs?: number
  /** Speech before the press that still counts: hosts often start answering, then press. */
  lookbackS?: number
  /** Longest stretch of speech the judge reads (spec: 120 s). */
  windowS?: number
  /** Other open questions checked alongside the taken one (spec: top 3). */
  alsoCheck?: number
}

/**
 * The host's side of a live session: which question is being answered, when to ask the judge,
 * the undo window, and what the glasses show. One per server; state per session.
 *
 * Gestures (spec input map; phase 5 refines the screens):
 *   lobby    press = go live · long = forget pairing · double = exit
 *   queue    press = take selected · swipe = move selection · long = flag spam · double = end session (asks first)
 *   taking   press = mark answered by hand · swipe = skip · double = put back in the queue
 *   sending  press = send now · swipe or double = cancel (back to taking)
 *   confirm  double = end the session · anything else = back to the queue
 */
export class HostController {
  private readonly modes = new Map<string, Mode>()
  private readonly judging = new Map<string, { rerun: boolean }>()
  /** Session offset (s) of the host's last word, from Deepgram's UtteranceEnd. */
  private readonly lastSpeechEnd = new Map<string, number>()
  private readonly now: () => number
  private readonly undoMs: number
  private readonly flashMs: number
  /** Viewers looking at the "Session ended" screen: their next press shows the lobby, not a new session. */
  private readonly sawEnd = new Set<Viewer>()

  constructor(private readonly o: ControllerOptions) {
    this.now = o.now ?? Date.now
    this.undoMs = o.undoMs ?? 3000
    this.flashMs = o.flashMs ?? 2500
    o.speech.onEvent((e) => {
      if (e.type === 'utterance_end') {
        this.lastSpeechEnd.set(e.sessionId, e.atS)
        void this.utteranceEnded(e.sessionId)
      }
    })
    o.sessions.onEvent((e) => {
      if (e.type === 'ended') this.clear(e.session.id)
    })
  }

  /** Selected queue row, read by the queue publisher. */
  selected(sessionId: string): number {
    const m = this.modes.get(sessionId)
    return m?.kind === 'queue' ? m.selected : 0
  }

  /** The session ended while these viewers watched. */
  ended(viewers: Viewer[]): void {
    for (const v of viewers) this.sawEnd.add(v)
  }

  /** A gesture from the glasses. Returns false to leave it to the glasses (double = exit). */
  input(g: Gesture, idx?: number, viewer: Viewer = DEV): boolean {
    const session = this.o.sessionFor(viewer)
    if (!session || session.status !== 'live') return this.inLobby(viewer, g)
    this.sawEnd.delete(viewer)
    const mode = this.mode(session.id)
    switch (mode.kind) {
      case 'queue':
        return this.inQueue(session, mode, g, idx)
      case 'taking':
        return this.inTaking(session, mode, g)
      case 'sending':
        return this.inSending(session, mode, g)
      case 'flash':
        // Any gesture just skips the flash, so a double-press here never exits by accident.
        clearTimeout(mode.timer)
        this.set(session.id, mode.next)
        return true
      case 'confirm_end':
        if (g === 'double') this.o.endSession(session)
        else this.toQueue(session.id)
        return true
    }
  }

  /** What the glasses should show for this session right now (reconnects). */
  screen(sessionId: string): Screen | undefined {
    const mode = this.mode(sessionId)
    switch (mode.kind) {
      case 'taking': {
        const c = this.o.store.get(mode.clusterId)
        return c ? { view: 'taking', id: c.id, n: Math.max(c.asks, c.askers), title: c.title } : undefined
      }
      case 'sending':
        return this.sendingScreen(mode)
      case 'confirm_end':
        return { view: 'confirm_end', open: this.o.store.ranked(sessionId).length }
      default:
        return this.o.publisher.screen(sessionId)
    }
  }

  private inLobby(viewer: Viewer, g: Gesture): boolean {
    const lobby = this.o.lobby
    if (!lobby || viewer === DEV) return false
    if (g === 'double') return false // exit
    if (g === 'long') {
      lobby.unpair(viewer)
      return true
    }
    if (g === 'press') {
      if (this.sawEnd.delete(viewer)) lobby.showLobby(viewer)
      else lobby.goLive(viewer)
    }
    return true
  }

  private mode(sessionId: string): Mode {
    return this.modes.get(sessionId) ?? { kind: 'queue', selected: 0 }
  }

  // ------------------------------------------------------------ queue

  private inQueue(session: Session, mode: Extract<Mode, { kind: 'queue' }>, g: Gesture, idx?: number): boolean {
    const ranked = this.o.store.ranked(session.id)
    if (g === 'next' || g === 'prev') {
      const max = Math.min(ranked.length, 5) - 1
      const selected = Math.max(0, Math.min(max, mode.selected + (g === 'next' ? 1 : -1)))
      this.modes.set(session.id, { kind: 'queue', selected })
      this.o.publisher.publishNow(session.id)
      return true
    }
    if (g === 'press') {
      const cluster = ranked[idx ?? mode.selected] ?? ranked[0]
      if (!cluster) return true
      this.o.store.take(cluster.id, this.now())
      this.o.writer.taken(session, cluster.id)
      this.o.log.info({ session: session.id, cluster: cluster.id, title: cluster.title }, 'question taken')
      this.set(session.id, { kind: 'taking', clusterId: cluster.id, takenS: this.o.speech.offset(session, this.now()) })
      return true
    }
    if (g === 'long') {
      const cluster = ranked[idx ?? mode.selected] ?? ranked[0]
      if (cluster) this.o.flagSpam(session, cluster.id)
      this.o.publisher.publishNow(session.id)
      return true
    }
    if (g === 'double') {
      this.modes.set(session.id, { kind: 'confirm_end' })
      this.o.publisher.hold(session.id, true)
      this.o.show(session.id, { view: 'confirm_end', open: ranked.length })
      return true
    }
    return true
  }

  // ------------------------------------------------------------ taking

  private inTaking(session: Session, mode: Extract<Mode, { kind: 'taking' }>, g: Gesture): boolean {
    if (g === 'press') {
      void this.manual(session, mode)
    } else if (g === 'next' || g === 'prev') {
      this.o.store.skip(mode.clusterId)
      this.o.log.info({ cluster: mode.clusterId }, 'question skipped')
      this.toQueue(session.id)
    } else if (g === 'double') {
      this.o.store.release(mode.clusterId)
      this.toQueue(session.id)
    }
    return true
  }

  /** Host pressed "answered": summary from the same transcript window, then the usual undo window. */
  private async manual(session: Session, mode: Extract<Mode, { kind: 'taking' }>): Promise<void> {
    const cluster = this.o.store.get(mode.clusterId)
    if (!cluster) return
    const transcript = this.transcript(session, mode.takenS)
    let summary = ''
    try {
      if (this.o.judge && transcript) summary = await this.o.judge.summarize({ question: cluster.title, transcript })
    } catch (err) {
      this.o.log.warn({ err }, 'manual summary failed; posting without one')
    }
    if (!this.still(session.id, mode)) return
    this.startSending(session, mode, [
      { clusterId: cluster.id, title: cluster.title, askers: cluster.askers, summary, quote: '', offsetS: this.o.speech.offset(session, this.now()), manual: true },
    ])
  }

  // ------------------------------------------------------------ judging

  private async utteranceEnded(sessionId: string): Promise<void> {
    const mode = this.modes.get(sessionId)
    if (mode?.kind !== 'taking' || !this.o.judge) return
    const running = this.judging.get(sessionId)
    if (running) {
      running.rerun = true // judge again with the longer transcript once this call returns
      return
    }
    const state = { rerun: false }
    this.judging.set(sessionId, state)
    try {
      do {
        state.rerun = false
        await this.judgeOnce(sessionId)
      } while (state.rerun && this.modes.get(sessionId)?.kind === 'taking')
    } finally {
      this.judging.delete(sessionId)
    }
  }

  private async judgeOnce(sessionId: string): Promise<void> {
    const session = this.o.sessions.get(sessionId)
    const mode = this.modes.get(sessionId)
    if (!session || session.status !== 'live' || mode?.kind !== 'taking') return
    const taken = this.o.store.get(mode.clusterId)
    if (!taken) return
    const transcript = this.transcript(session, mode.takenS)
    if (!transcript) return

    const others = this.o.store.ranked(sessionId).filter((c) => c.id !== taken.id).slice(0, this.o.alsoCheck ?? 3)
    const questions: JudgeQuestion[] = [{ id: taken.id, title: taken.title, taken: true }, ...others.map((c) => ({ id: c.id, title: c.title, taken: false }))]
    const started = this.now()
    let verdicts: Verdict[] = []
    try {
      verdicts = await this.o.judge!.judge({ questions, transcript })
    } catch (err) {
      this.o.log.warn({ err }, 'judge failed; question stays open')
    }
    // The host may have skipped, put back or answered by hand while the judge was thinking.
    if (!this.still(sessionId, mode)) return

    const offsetS = this.o.speech.offset(session, this.now())
    const accepted: Pending[] = []
    for (const q of questions) {
      const v = verdicts.find((x) => x.id === q.id)
      const why = v ? rejection(v, q.taken, transcript) : 'no verdict'
      const c = q.taken ? taken : others.find((o) => o.id === q.id)!
      this.o.log.info({ session: sessionId, cluster: q.id, taken: q.taken, accepted: !why, why, confidence: v?.confidence, ms: this.now() - started }, 'judged')
      if (!why) accepted.push({ clusterId: q.id, title: c.title, askers: c.askers, summary: v!.summary.trim(), quote: v!.quote, offsetS, manual: false })
    }
    // The taken question first: it is what the HUD shows.
    accepted.sort((a, b) => Number(b.clusterId === taken.id) - Number(a.clusterId === taken.id))

    const speechEndS = this.lastSpeechEnd.get(sessionId)
    const speechEndAt = speechEndS !== undefined && session.startedAt !== null ? session.startedAt + speechEndS * 1000 : undefined
    if (accepted.length) return this.startSending(session, mode, accepted, speechEndAt)
    // Spec: the matcher fails toward "still open". The host can keep talking, skip, or press.
    this.flash(sessionId, { view: 'still_open' }, mode)
  }

  // ------------------------------------------------------------ sending (undo window)

  private startSending(session: Session, from: Extract<Mode, { kind: 'taking' }>, batch: Pending[], speechEndAt?: number): void {
    const deadline = this.now() + this.undoMs
    const timer = setInterval(() => {
      const m = this.modes.get(session.id)
      if (m?.kind !== 'sending' || m.timer !== timer) return clearInterval(timer)
      if (this.now() >= m.deadline) void this.send(session, m)
      else this.o.show(session.id, this.sendingScreen(m))
    }, Math.min(1000, this.undoMs))
    const mode: Mode = { kind: 'sending', clusterId: from.clusterId, takenS: from.takenS, batch, deadline, timer, speechEndAt }
    this.set(session.id, mode)
  }

  private inSending(session: Session, mode: Extract<Mode, { kind: 'sending' }>, g: Gesture): boolean {
    if (g === 'press') {
      void this.send(session, mode)
    } else {
      clearInterval(mode.timer)
      this.o.log.info({ cluster: mode.clusterId }, 'answer cancelled by host')
      this.set(session.id, { kind: 'taking', clusterId: mode.clusterId, takenS: mode.takenS })
    }
    return true
  }

  private async send(session: Session, mode: Extract<Mode, { kind: 'sending' }>): Promise<void> {
    clearInterval(mode.timer)
    if (this.modes.get(session.id) !== mode) return
    const first = mode.batch[0]!
    // Show the result straight away; the replies queue behind the rate limiter.
    this.flash(session.id, { view: 'answered', n: mode.batch.reduce((n, p) => n + p.askers, 0), summary: first.summary || 'Answered live' }, { kind: 'queue', selected: 0 })
    for (const p of mode.batch) {
      this.o.store.markAnswered(p.clusterId, { at: this.now(), summary: p.summary, quote: p.quote, offsetS: p.offsetS, manual: p.manual })
      this.o.log.info({ session: session.id, cluster: p.clusterId, manual: p.manual, summary: p.summary }, 'question answered')
    }
    // If the host took one question but only others were answered, the taken one goes back to the queue.
    if (!mode.batch.some((p) => p.clusterId === mode.clusterId)) this.o.store.release(mode.clusterId)
    for (const p of mode.batch) {
      await this.o.writer.answered(session, p.clusterId, p.summary, p.offsetS)
      // The spec's latency target: host stops talking -> reply in the group (includes the undo window).
      if (mode.speechEndAt !== undefined) {
        this.o.log.info({ session: session.id, cluster: p.clusterId, latencyMs: this.now() - mode.speechEndAt, undoMs: this.undoMs }, 'answer posted')
      }
    }
  }

  private sendingScreen(m: Extract<Mode, { kind: 'sending' }>): Screen {
    const first = m.batch[0]!
    return {
      view: 'sending',
      n: m.batch.reduce((n, p) => n + p.askers, 0),
      summary: first.summary || 'Answered live',
      seconds: Math.max(1, Math.ceil((m.deadline - this.now()) / 1000)),
    }
  }

  // ------------------------------------------------------------ screens and helpers

  private transcript(session: Session, takenS: number): string {
    const nowS = this.o.speech.offset(session, this.now())
    const since = Math.max(takenS - (this.o.lookbackS ?? 5), nowS - (this.o.windowS ?? 120), 0)
    return this.o.speech
      .segments(session.id, since)
      .map((s) => s.text)
      .join(' ')
      .trim()
  }

  private still(sessionId: string, mode: Mode): boolean {
    return this.modes.get(sessionId) === mode
  }

  private flash(sessionId: string, screen: Screen, next: Mode): void {
    const timer = setTimeout(() => {
      const m = this.modes.get(sessionId)
      if (m?.kind === 'flash' && m.timer === timer) this.set(sessionId, next)
    }, this.flashMs)
    this.modes.set(sessionId, { kind: 'flash', next, timer })
    this.o.publisher.hold(sessionId, true)
    this.o.show(sessionId, screen)
  }

  private toQueue(sessionId: string): void {
    this.set(sessionId, { kind: 'queue', selected: 0 })
  }

  /** Switches mode and shows its screen. */
  private set(sessionId: string, mode: Mode): void {
    this.modes.set(sessionId, mode)
    switch (mode.kind) {
      case 'queue':
        this.o.publisher.hold(sessionId, false)
        this.o.publisher.publishNow(sessionId)
        return
      case 'taking': {
        this.o.publisher.hold(sessionId, true)
        const c = this.o.store.get(mode.clusterId)
        if (c) this.o.show(sessionId, { view: 'taking', id: c.id, n: Math.max(c.asks, c.askers), title: c.title })
        return
      }
      case 'sending':
        this.o.publisher.hold(sessionId, true)
        this.o.show(sessionId, this.sendingScreen(mode))
        return
      case 'flash':
      case 'confirm_end':
        return
    }
  }

  private clear(sessionId: string): void {
    this.lastSpeechEnd.delete(sessionId)
    const m = this.modes.get(sessionId)
    if (m?.kind === 'sending') clearInterval(m.timer)
    if (m?.kind === 'flash') clearTimeout(m.timer)
    this.modes.delete(sessionId)
  }

  stop(): void {
    for (const id of [...this.modes.keys()]) this.clear(id)
  }
}
