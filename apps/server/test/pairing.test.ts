import { afterEach, describe, expect, it } from 'vitest'
import { Bot } from 'grammy'
import WebSocket from 'ws'
import type { AddressInfo } from 'node:net'
import type { ServerMessage } from '@answered/protocol'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { TEXT } from '../src/telegram/handlers.js'
import { Outbox } from '../src/telegram/outbox.js'

const SECRET = 's'
const GROUP = { id: -1001111111111, type: 'supergroup' as const, title: 'Builders Hub' }
const OTHER = { id: -1002222222222, type: 'supergroup' as const, title: 'Elsewhere' }
const ADMIN = { id: 10, is_bot: false, first_name: 'Lino' }
const MEMBER = { id: 11, is_bot: false, first_name: 'Ada' }

const closers: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function setup() {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const bot = new Bot('1:x', { botInfo: { id: 42, is_bot: true, first_name: 'Answered', username: 'AnsweredHQBot' } as Bot['botInfo'] })
  let mid = 5000
  bot.api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, unknown>
    calls.push({ method, payload: p })
    if (method === 'getChatMember') return { ok: true, result: { status: p.user_id === ADMIN.id ? 'administrator' : 'member', user: { id: p.user_id } } } as never
    return { ok: true, result: method === 'sendMessage' ? { message_id: mid++, date: 0, chat: GROUP } : true } as never
  })
  const clock = { t: 0 }
  const outbox = new Outbox({ sleep: async (ms) => void (clock.t += ms), now: () => clock.t })
  const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: ':memory:', TG_WEBHOOK_SECRET: SECRET, GLASSES_DEV_TOKEN: 'dev' })
  const built = await buildApp(config, { bot, outbox, flashMs: 30, undoMs: 30 })
  await built.app.listen({ port: 0, host: '127.0.0.1' })
  closers.push(() => built.app.close())
  const port = (built.app.server.address() as AddressInfo).port

  let update = 1
  let msg = 1
  const say = async (from: typeof ADMIN, text: string, chat: typeof GROUP = GROUP) => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/tg/webhook',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: {
        update_id: update++,
        message: {
          message_id: msg++, date: Math.floor(Date.now() / 1000), chat, from, text,
          ...(text.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
        },
      },
    })
    expect(res.statusCode).toBe(200)
  }
  const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.payload.text))

  /** Glasses: connect (with or without a token), say hello, record what the server sends. */
  const glasses = (token = '') => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/glasses?token=${encodeURIComponent(token)}`)
    const got: ServerMessage[] = []
    const state = { closed: undefined as number | undefined }
    ws.on('message', (d) => got.push(JSON.parse(d.toString())))
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', app: 'test', version: '0', mic: 'glasses' })))
    ws.on('close', (code) => (state.closed = code))
    closers.push(() => ws.close())
    const screen = () => [...got].reverse().find((m) => m.t === 'screen') as Extract<ServerMessage, { t: 'screen' }> | undefined
    const input = (g: 'press' | 'double' | 'long' | 'next', idx?: number) => ws.send(JSON.stringify({ t: 'input', g, ...(idx !== undefined ? { idx } : {}) }))
    return { ws, got, state, screen, input }
  }

  /** Full pairing: code on the glasses, /pair in the group, token back. */
  const pair = async () => {
    const g = glasses()
    await until(() => g.screen()?.view === 'pair')
    const code = (g.screen() as { code: string }).code
    await say(ADMIN, `/pair ${code}`)
    await until(() => g.got.some((m) => m.t === 'paired'))
    const token = (g.got.find((m) => m.t === 'paired') as { token: string }).token
    await until(() => g.state.closed !== undefined)
    return token
  }

  return { ...built, say, sent, glasses, pair, calls }
}

describe('pairing', () => {
  it('pairs glasses from a group admin\'s /pair <code>, then shows that group\'s lobby', async () => {
    const t = await setup()
    const token = await t.pair()
    expect(token.length).toBeGreaterThan(20)
    await until(() => t.sent().includes(TEXT.paired('Lino', 'Builders Hub')))

    const g = t.glasses(token)
    await until(() => g.screen()?.view === 'lobby')
    expect(g.screen()).toMatchObject({ view: 'lobby', group: 'Builders Hub' })
  })

  it('refuses /pair from non-admins and for codes nobody is showing', async () => {
    const t = await setup()
    const g = t.glasses()
    await until(() => g.screen()?.view === 'pair')
    await t.say(MEMBER, `/pair ${(g.screen() as { code: string }).code}`)
    await t.say(ADMIN, '/pair 0000')
    await t.say(ADMIN, '/pair')
    await until(() => t.sent().length === 3)
    expect(t.sent()).toEqual([TEXT.adminsOnly, TEXT.pairUnknown, TEXT.pairUsage])
    expect(g.state.closed).toBeUndefined() // still waiting
  })

  it('rejects unknown tokens so the glasses can fall back to pairing', async () => {
    const t = await setup()
    const g = t.glasses('not-a-token')
    await until(() => g.state.closed !== undefined)
    expect(g.state.closed).toBe(4401)
  })
})

describe('host gestures on paired glasses', () => {
  it('press in the lobby goes live and posts the opening message; the queue follows', async () => {
    const t = await setup()
    const g = t.glasses(await t.pair())
    await until(() => g.screen()?.view === 'lobby')
    g.input('press')
    await until(() => g.screen()?.view === 'queue')
    expect(t.sessions.open(GROUP.id)?.status).toBe('live')
    await until(() => t.sent().includes(TEXT.opening))
  })

  it('double-press asks before ending; a second double-press ends the session', async () => {
    const t = await setup()
    const g = t.glasses(await t.pair())
    await until(() => g.screen()?.view === 'lobby')
    g.input('press')
    await until(() => g.screen()?.view === 'queue')

    g.input('double')
    await until(() => g.screen()?.view === 'confirm_end')
    g.input('press') // changed my mind
    await until(() => g.screen()?.view === 'queue')
    expect(g.got.some((m) => m.t === 'exit')).toBe(false)

    g.input('double')
    await until(() => g.screen()?.view === 'confirm_end')
    g.input('double')
    await until(() => g.screen()?.view === 'ended')
    expect(t.sessions.open(GROUP.id)).toBeUndefined()
    await until(() => t.sent().some((s) => s.startsWith('<b>Q&amp;A recap')))

    // The first press after the end shows the lobby; it does not start a new session by accident.
    g.input('press')
    await until(() => g.screen()?.view === 'lobby')
    expect(t.sessions.open(GROUP.id)).toBeUndefined()
  })

  it('/live in the group shows the queue on the paired glasses too', async () => {
    const t = await setup()
    const g = t.glasses(await t.pair())
    await until(() => g.screen()?.view === 'lobby')
    await t.say(ADMIN, '/live')
    await until(() => g.screen()?.view === 'queue')
  })

  it('only shows the host their own group', async () => {
    const t = await setup()
    const g = t.glasses(await t.pair())
    await until(() => g.screen()?.view === 'lobby')
    await t.say(ADMIN, '/live', OTHER) // a session in a group these glasses are not paired to
    await new Promise((r) => setTimeout(r, 100))
    expect(g.screen()?.view).toBe('lobby')
    g.input('double') // lobby double = exit, not "end that other session"
    await until(() => g.got.some((m) => m.t === 'exit'))
    expect(t.sessions.open(OTHER.id)?.status).toBe('live')
  })

  it('long press in the lobby forgets the pairing', async () => {
    const t = await setup()
    const token = await t.pair()
    const g = t.glasses(token)
    await until(() => g.screen()?.view === 'lobby')
    g.input('long')
    await until(() => g.got.some((m) => m.t === 'unpaired'))
    const again = t.glasses(token)
    await until(() => again.state.closed !== undefined)
    expect(again.state.closed).toBe(4401)
  })

  it('long press in the queue flags the selected question as spam and deletes its messages', async () => {
    const t = await setup()
    const g = t.glasses(await t.pair())
    await until(() => g.screen()?.view === 'lobby')
    g.input('press')
    await until(() => g.screen()?.view === 'queue')
    const session = t.sessions.open(GROUP.id)!
    t.sessions.capture(GROUP.id, { messageId: 77, userId: 99, userName: 'Shill', text: 'airdrop when? t.me/scam', at: Date.now() })
    t.store.apply(session.id, GROUP.id, [{ messageId: 77, isQuestion: true, spam: false, canonical: 'Airdrop when?', cluster: 'new:x' }])
    t.publisher.changed(session.id)

    g.input('long', 0)
    await until(() => t.calls.some((c) => c.method === 'deleteMessage'))
    expect(t.calls.find((c) => c.method === 'deleteMessage')!.payload).toMatchObject({ chat_id: GROUP.id, message_id: 77 })
    expect(t.store.ranked(session.id)).toHaveLength(0)
  })
})

describe('pairing code refresh', () => {
  it('replaces the code on screen before it expires', async () => {
    const { GlassesHub } = await import('../src/ws/glasses.js')
    const pino = (await import('pino')).default
    const hub = new GlassesHub(pino({ level: 'silent' }), {}, 200) // 200 ms codes, refreshed every 100 ms
    const sent: string[] = []
    const socket = { readyState: 1, OPEN: 1, send: (d: string) => sent.push(d), on: () => {}, close: () => {} }
    hub.attach(socket as never, undefined)
    const codes = () => sent.map((d) => JSON.parse(d)).filter((m) => m.view === 'pair').map((m) => m.code as string)
    await until(() => new Set(codes()).size >= 3)
    const latest = codes().at(-1)!
    expect(hub.pairingWaiting(latest)).toBe(true)
    expect(hub.pairingWaiting(codes()[0]!)).toBe(codes()[0] === latest)
    hub.closeAll()
  })
})
