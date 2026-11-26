import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/db/index.js'
import { SessionService } from '../src/sessions.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const start = (s: SessionService, chatId = -100) =>
  s.start({ chatId, chatTitle: 'G', host: { tgUserId: 1, name: 'Host' } })

describe('database', () => {
  it('migrates once and keeps data across restarts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'answered-'))
    dirs.push(dir)
    const url = `file:${join(dir, 'nested', 'answered.db')}`

    const db1 = openDb(url)
    const { session } = start(new SessionService(db1))
    db1.close()

    const db2 = openDb(url)
    expect(db2.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    expect(new SessionService(db2).open(-100)?.id).toBe(session.id)
    db2.close()
  })

  it('allows only one open session per group, but a new one after the last ended', () => {
    const sessions = new SessionService(openDb(':memory:'))
    const first = start(sessions)
    expect(start(sessions)).toEqual({ session: first.session, created: false })
    sessions.end(-100)
    const second = start(sessions)
    expect(second.created).toBe(true)
    expect(second.session.id).not.toBe(first.session.id)
  })

  it('reuses the host row for the same Telegram user and updates the name', () => {
    const db = openDb(':memory:')
    const sessions = new SessionService(db)
    const a = sessions.upsertHost(7, 'Old')
    const b = sessions.upsertHost(7, 'New')
    expect(b.id).toBe(a.id)
    expect(db.prepare('SELECT name FROM hosts').all()).toEqual([{ name: 'New' }])
  })

  it('stores nothing when no session is live', () => {
    const db = openDb(':memory:')
    const sessions = new SessionService(db)
    expect(sessions.capture(-100, { messageId: 1, userId: 2, userName: 'A', text: 'hi?', at: 0 })).toBeUndefined()
    expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
  })
})
