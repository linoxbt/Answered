import { randomBytes } from 'node:crypto'
import { tx, type Db } from './db/index.js'

export type SessionStatus = 'lobby' | 'live' | 'ended'

export interface Session {
  id: string
  hostId: string
  chatId: number
  chatTitle: string
  chatUsername: string | null
  status: SessionStatus
  startedAt: number | null
  endedAt: number | null
  openingMessageId: number | null
  recapMessageId: number | null
}

export interface Host {
  id: string
  tgUserId: number
  name: string
}

export interface CapturedMessage {
  messageId: number
  userId: number
  userName: string
  text: string
  replyTo?: number
  at: number
}

export interface SessionStats {
  messages: number
  clusters: number
  answered: number
  open: number
}

export type SessionEvent =
  | { type: 'started'; session: Session }
  | { type: 'ended'; session: Session; stats: SessionStats }

interface SessionRow {
  id: string
  host_id: string
  chat_id: number
  chat_title: string
  chat_username: string | null
  status: SessionStatus
  started_at: number | null
  ended_at: number | null
  opening_message_id: number | null
  recap_message_id: number | null
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    hostId: r.host_id,
    chatId: r.chat_id,
    chatTitle: r.chat_title,
    chatUsername: r.chat_username,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    openingMessageId: r.opening_message_id,
    recapMessageId: r.recap_message_id,
  }
}

/** Unguessable id: session ids end up in public recap URLs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`
}

export class SessionService {
  private readonly listeners = new Set<(e: SessionEvent) => void>()

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  onEvent(fn: (e: SessionEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(e: SessionEvent): void {
    for (const fn of this.listeners) fn(e)
  }

  upsertHost(tgUserId: number, name: string): Host {
    const existing = this.db.prepare('SELECT id, tg_user_id, name FROM hosts WHERE tg_user_id = ?').get(tgUserId) as
      | { id: string; tg_user_id: number; name: string }
      | undefined
    if (existing) {
      if (existing.name !== name) this.db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(name, existing.id)
      return { id: existing.id, tgUserId, name }
    }
    const id = newId('h')
    this.db.prepare('INSERT INTO hosts (id, tg_user_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, tgUserId, name, this.now())
    return { id, tgUserId, name }
  }

  /** The group's open (lobby or live) session, if any. */
  open(chatId: number): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE chat_id = ? AND status <> 'ended'").get(chatId) as SessionRow | undefined
    return row ? toSession(row) : undefined
  }

  /** Every live session (used after a restart to resume their pipelines and screens). */
  live(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE status = 'live'").all() as unknown as SessionRow[]).map(toSession)
  }

  /** The session glasses input and audio belong to until pairing (phase 5): the newest live one. */
  active(): Session | undefined {
    return this.live().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? toSession(row) : undefined
  }

  /** Starts a live session in a group, or returns the one already open there. */
  start(input: { chatId: number; chatTitle: string; chatUsername?: string; host: { tgUserId: number; name: string } }): {
    session: Session
    created: boolean
  } {
    const result = tx(this.db, () => {
      const existing = this.open(input.chatId)
      if (existing) return { session: existing, created: false }
      const host = this.upsertHost(input.host.tgUserId, input.host.name)
      const id = newId('s')
      this.db
        .prepare(
          "INSERT INTO sessions (id, host_id, chat_id, chat_title, chat_username, status, started_at) VALUES (?, ?, ?, ?, ?, 'live', ?)",
        )
        .run(id, host.id, input.chatId, input.chatTitle, input.chatUsername ?? null, this.now())
      return { session: this.get(id)!, created: true }
    })
    if (result.created) this.emit({ type: 'started', session: result.session })
    return result
  }

  setOpeningMessage(sessionId: string, messageId: number): void {
    this.db.prepare('UPDATE sessions SET opening_message_id = ? WHERE id = ?').run(messageId, sessionId)
  }

  /** Stores a group message if the group has a live session. Returns the session it was stored under. */
  capture(chatId: number, m: CapturedMessage): Session | undefined {
    const session = this.open(chatId)
    if (!session || session.status !== 'live') return undefined
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (chat_id, message_id, session_id, user_id, user_name, text, reply_to, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(chatId, m.messageId, session.id, m.userId, m.userName, m.text, m.replyTo ?? null, m.at)
    return session
  }

  /** Applies an edit to a captured message and clears its classification so it is re-read. Returns true if it was captured. */
  edit(chatId: number, messageId: number, text: string, at: number): boolean {
    const res = this.db
      .prepare(
        `UPDATE messages SET text = ?, edited_at = ?, is_question = NULL, spam = 0, canonical = NULL, embedding = NULL
         WHERE chat_id = ? AND message_id = ?`,
      )
      .run(text, at, chatId, messageId)
    return res.changes > 0
  }

  /** A basic group that becomes a supergroup gets a new chat id; keep its data attached. */
  migrateChat(fromChatId: number, toChatId: number): void {
    tx(this.db, () => {
      this.db.prepare('UPDATE sessions SET chat_id = ? WHERE chat_id = ?').run(toChatId, fromChatId)
      this.db.prepare('UPDATE messages SET chat_id = ? WHERE chat_id = ?').run(toChatId, fromChatId)
      this.db.prepare('UPDATE votes SET chat_id = ? WHERE chat_id = ?').run(toChatId, fromChatId)
    })
  }

  stats(sessionId: string): SessionStats {
    const q = (sql: string) => (this.db.prepare(sql).get(sessionId) as { n: number }).n
    return {
      messages: q('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?'),
      clusters: q("SELECT COUNT(*) AS n FROM clusters WHERE session_id = ? AND status <> 'skipped'"),
      answered: q("SELECT COUNT(*) AS n FROM clusters WHERE session_id = ? AND status = 'answered'"),
      open: q("SELECT COUNT(*) AS n FROM clusters WHERE session_id = ? AND status IN ('open', 'taken')"),
    }
  }

  /**
   * Ends the group's open session. Raw messages and transcript segments are deleted here
   * (privacy promise in the README); clusters keep only titles, counts and answers for the recap.
   */
  end(chatId: number): { session: Session; stats: SessionStats } | undefined {
    const result = tx(this.db, () => {
      const open = this.open(chatId)
      if (!open) return undefined
      const stats = this.stats(open.id)
      this.db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(this.now(), open.id)
      this.db.prepare('DELETE FROM votes WHERE session_id = ?').run(open.id)
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(open.id)
      this.db.prepare('DELETE FROM segments WHERE session_id = ?').run(open.id)
      return { session: this.get(open.id)!, stats }
    })
    if (result) this.emit({ type: 'ended', ...result })
    return result
  }
}
