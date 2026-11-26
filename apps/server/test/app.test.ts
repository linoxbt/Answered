import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import type { AddressInfo } from 'node:net'
import type { ServerMessage } from '@answered/protocol'
import { buildApp } from '../src/app.js'
import { peakLevel } from '../src/ws/glasses.js'
import { loadConfig } from '../src/config.js'

const SECRET = 'test_secret-123'
const TOKEN = 'dev-token'

function config(overrides: Record<string, string> = {}) {
  return loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: ':memory:', TG_WEBHOOK_SECRET: SECRET, GLASSES_DEV_TOKEN: TOKEN, ...overrides })
}

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

async function start(overrides: Record<string, string> = {}) {
  const built = await buildApp(config(overrides))
  closers.push(() => built.app.close())
  return built
}

describe('config', () => {
  it('requires a webhook secret when a bot token is set', () => {
    expect(() => loadConfig({ TG_BOT_TOKEN: '123:abc' })).toThrow(/TG_WEBHOOK_SECRET/)
  })

  it('rejects secrets with characters Telegram does not allow', () => {
    expect(() => loadConfig({ TG_WEBHOOK_SECRET: 'has space' })).toThrow(/A-Z a-z 0-9/)
  })
})

describe('http', () => {
  it('GET /health', async () => {
    const { app } = await start()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, telegram: false, glasses: 0 })
  })

  it('rejects webhook calls without the secret header', async () => {
    const { app } = await start()
    const res = await app.inject({ method: 'POST', url: '/tg/webhook', payload: { update_id: 1 } })
    expect(res.statusCode).toBe(401)
  })

  it('rejects webhook calls with the wrong secret', async () => {
    const { app } = await start()
    const res = await app.inject({
      method: 'POST',
      url: '/tg/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
      payload: { update_id: 1 },
    })
    expect(res.statusCode).toBe(401)
  })

  it('accepts webhook calls with the right secret', async () => {
    const { app } = await start()
    const res = await app.inject({
      method: 'POST',
      url: '/tg/webhook',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: { update_id: 7, message: { message_id: 1, date: 0, chat: { id: -100, type: 'supergroup', title: 'T' }, text: 'hi' } },
    })
    expect(res.statusCode).toBe(200)
  })

  it('protects /debug/stats with the glasses token', async () => {
    const { app } = await start()
    expect((await app.inject({ method: 'GET', url: '/debug/stats' })).statusCode).toBe(401)
    const ok = await app.inject({ method: 'GET', url: '/debug/stats', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(ok.statusCode).toBe(200)
  })
})

describe('peakLevel', () => {
  it('reads s16le peaks', () => {
    const pcm = Buffer.alloc(8)
    pcm.writeInt16LE(-16384, 2)
    pcm.writeInt16LE(8000, 4)
    expect(peakLevel(pcm)).toBe(50)
    expect(peakLevel(Buffer.alloc(3200))).toBe(0)
  })
})

describe('WS /ws/glasses', () => {
  async function connect(token: string) {
    const built = await start()
    await built.app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = built.app.server.address() as AddressInfo
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/glasses?token=${token}`)
    const messages: ServerMessage[] = []
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())))
    closers.push(async () => ws.close())
    return { ...built, ws, messages }
  }

  const until = async (check: () => boolean, ms = 2000) => {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise((r) => setTimeout(r, 20))
    }
  }

  it('refuses a bad token', async () => {
    const { ws } = await connect('nope')
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)))
    expect(code).toBe(4401)
  })

  it('counts audio frames, records input, and turns the mic on after hello', async () => {
    const { ws, hub, messages } = await connect(TOKEN)
    await new Promise((r) => ws.on('open', r))

    ws.send(JSON.stringify({ t: 'hello', app: 'test', version: '1', mic: 'glasses' }))
    for (let i = 0; i < 5; i++) ws.send(Buffer.alloc(3200), { binary: true })
    ws.send(JSON.stringify({ t: 'input', g: 'next', src: 'ring' }))

    await until(() => hub.stats().connections[0]?.inputs === 1 && hub.stats().totalAudioBytes === 16000)
    const conn = hub.stats().connections[0]!
    expect(conn).toMatchObject({ audioFrames: 5, audioBytes: 16000, audioLevel: 0, mic: 'glasses', lastInput: { g: 'next', src: 'ring' } })
    expect(messages).toContainEqual({ t: 'audio', on: true, source: 'glasses' })
    expect(messages.some((m) => m.t === 'screen' && m.view === 'status')).toBe(true)
  })

  it('answers a double press with exit', async () => {
    const { ws, messages } = await connect(TOKEN)
    await new Promise((r) => ws.on('open', r))
    ws.send(JSON.stringify({ t: 'input', g: 'double' }))
    await until(() => messages.some((m) => m.t === 'exit'))
  })

  it('ignores malformed messages without dropping the connection', async () => {
    const { ws, hub } = await connect(TOKEN)
    await new Promise((r) => ws.on('open', r))
    ws.send('not json')
    ws.send(JSON.stringify({ t: 'input', g: 'dance' }))
    ws.send(JSON.stringify({ t: 'input', g: 'press' }))
    await until(() => hub.stats().connections[0]?.inputs === 1)
    expect(ws.readyState).toBe(WebSocket.OPEN)
  })
})
