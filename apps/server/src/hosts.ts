import { randomBytes, randomInt } from 'node:crypto'
import type { Db } from './db/index.js'
import { newId } from './sessions.js'

/** A host whose glasses are paired to one Telegram group. */
export interface PairedHost {
  id: string
  tgUserId: number
  name: string
  chatId: number
  chatTitle: string
}

interface HostRow {
  id: string
  tg_user_id: number
  name: string
  chat_id: number | null
  chat_title: string | null
}

const toHost = (r: HostRow): PairedHost | undefined =>
  r.chat_id === null ? undefined : { id: r.id, tgUserId: r.tg_user_id, name: r.name, chatId: r.chat_id, chatTitle: r.chat_title ?? 'Group' }

/** Host tokens and the group each host's glasses follow. */
export class HostDirectory {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Pairs a Telegram user's glasses with a group: issues a fresh token (any older glasses for this
   * host stop working) and remembers the group. Returns the token.
   */
  pair(input: { tgUserId: number; name: string; chatId: number; chatTitle: string }): { host: PairedHost; token: string } {
    const token = randomBytes(24).toString('base64url')
    const existing = this.db.prepare('SELECT id FROM hosts WHERE tg_user_id = ?').get(input.tgUserId) as { id: string } | undefined
    const id = existing?.id ?? newId('h')
    if (existing) {
      this.db
        .prepare('UPDATE hosts SET name = ?, host_token = ?, chat_id = ?, chat_title = ? WHERE id = ?')
        .run(input.name, token, input.chatId, input.chatTitle, id)
    } else {
      this.db
        .prepare('INSERT INTO hosts (id, tg_user_id, name, host_token, chat_id, chat_title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, input.tgUserId, input.name, token, input.chatId, input.chatTitle, this.now())
    }
    return { host: this.get(id)!, token }
  }

  byToken(token: string): PairedHost | undefined {
    if (!token) return undefined
    const row = this.db.prepare('SELECT id, tg_user_id, name, chat_id, chat_title FROM hosts WHERE host_token = ?').get(token) as HostRow | undefined
    return row ? toHost(row) : undefined
  }

  get(id: string): PairedHost | undefined {
    const row = this.db.prepare('SELECT id, tg_user_id, name, chat_id, chat_title FROM hosts WHERE id = ?').get(id) as HostRow | undefined
    return row ? toHost(row) : undefined
  }

  /** Hosts whose glasses follow this group. */
  forChat(chatId: number): PairedHost[] {
    const rows = this.db.prepare('SELECT id, tg_user_id, name, chat_id, chat_title FROM hosts WHERE chat_id = ? AND host_token IS NOT NULL').all(chatId) as unknown as HostRow[]
    return rows.map(toHost).filter((h): h is PairedHost => Boolean(h))
  }

  /** Forgets a pairing: the token stops working and the glasses show a new code. */
  unpair(id: string): void {
    this.db.prepare('UPDATE hosts SET host_token = NULL WHERE id = ?').run(id)
  }

  /** A group that became a supergroup gets a new id. */
  migrateChat(from: number, to: number): void {
    this.db.prepare('UPDATE hosts SET chat_id = ? WHERE chat_id = ?').run(to, from)
  }
}

/** Short codes the glasses show while waiting for `/pair <code>`. In memory: they last minutes. */
export class PairingCodes<T> {
  private readonly codes = new Map<string, { value: T; expires: number }>()

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** A fresh 4-digit code for `value` (unique among live codes). */
  create(value: T): string {
    this.sweep()
    for (;;) {
      const code = String(randomInt(1000, 10000))
      if (!this.codes.has(code)) {
        this.codes.set(code, { value, expires: this.now() + this.ttlMs })
        return code
      }
    }
  }

  /** Single use: returns the waiting value and forgets the code. */
  claim(code: string): T | undefined {
    this.sweep()
    const entry = this.codes.get(code)
    this.codes.delete(code)
    return entry?.value
  }

  /** Extends a live code's expiry. Returns false if it already expired (or was claimed). */
  renew(code: string): boolean {
    this.sweep()
    const entry = this.codes.get(code)
    if (!entry) return false
    entry.expires = this.now() + this.ttlMs
    return true
  }

  has(code: string): boolean {
    this.sweep()
    return this.codes.has(code)
  }

  release(code: string): void {
    this.codes.delete(code)
  }

  private sweep(): void {
    const now = this.now()
    for (const [code, e] of this.codes) if (e.expires <= now) this.codes.delete(code)
  }
}
