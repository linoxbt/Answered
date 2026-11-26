import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import pino from 'pino'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { deepgramFactory, deepgramUrl } from '../src/speech/deepgram.js'
import { AudioClock } from '../src/speech/types.js'
import type { SpeechEvent } from '../src/speech/index.js'
import { readPcmWav } from '../src/speech/wav.js'

const log = pino({ level: 'silent' })
const closers: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** A stand-in for wss://api.deepgram.com/v1/listen that records what it receives. */
async function fakeDeepgram(opts: { status?: number } = {}) {
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (_info, done) => (opts.status ? done(false, opts.status) : done(true)),
  })
  await new Promise((r) => wss.once('listening', r))
  const state = {
    connections: 0,
    auth: [] as string[],
    urls: [] as URL[],
    audioBytes: 0,
    control: [] as string[],
    socket: undefined as ServerSocket | undefined,
  }
  wss.on('connection', (socket, req) => {
    state.connections += 1
    state.auth.push(String(req.headers.authorization))
    state.urls.push(new URL(req.url!, 'ws://x'))
    state.socket = socket
    socket.on('message', (data, isBinary) => {
      if (isBinary) state.audioBytes += (data as Buffer).length
      else {
        const msg = JSON.parse(data.toString()) as { type: string }
        state.control.push(msg.type)
        if (msg.type === 'CloseStream') socket.close(1000)
      }
    })
  })
  closers.push(() => new Promise((r) => wss.close(r)))
  const send = (msg: unknown) => state.socket!.send(JSON.stringify(msg))
  return {
    state,
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/listen`,
    final: (text: string, start: number, duration: number, speechFinal = true) =>
      send({
        type: 'Results', start, duration, is_final: true, speech_final: speechFinal,
        channel: { alternatives: [{ transcript: text, words: text.split(' ').map((w, i) => ({ word: w.toLowerCase(), punctuated_word: w, start: start + i * 0.2, end: start + i * 0.2 + 0.2, confidence: 0.99 })) }] },
      }),
    interim: (text: string) => send({ type: 'Results', start: 0, duration: 1, is_final: false, speech_final: false, channel: { alternatives: [{ transcript: text, words: [] }] } }),
    utteranceEnd: (lastWordEnd: number) => send({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: lastWordEnd }),
    drop: () => state.socket!.close(1011, 'server restart'),
  }
}

async function appWithFake(fake: Awaited<ReturnType<typeof fakeDeepgram>>, extra: Record<string, unknown> = {}) {
  const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: ':memory:', GLASSES_DEV_TOKEN: 't' })
  const built = await buildApp(config, {
    transcriber: deepgramFactory({ apiKey: 'dg-test-key', url: fake.url, keyterms: ['mainnet', 'Answered HQ'], log, ...extra }),
  })
  closers.push(() => built.app.close())
  const events: SpeechEvent[] = []
  built.speech.onEvent((e) => events.push(e))
  const { session } = built.sessions.start({ chatId: -100, chatTitle: 'G', host: { tgUserId: 1, name: 'H' } })
  return { ...built, events, session }
}

const frame = () => Buffer.alloc(3200, 1)

describe('Deepgram request', () => {
  it('uses the verified parameters, with one keyterm param per term', () => {
    const url = new URL(deepgramUrl({ keyterms: ['mainnet', 'Answered HQ', ' '] }))
    expect(url.origin + url.pathname).toBe('wss://api.deepgram.com/v1/listen')
    expect(Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'keyterm'))).toEqual({
      model: 'nova-3', language: 'en', smart_format: 'true', encoding: 'linear16', sample_rate: '16000', channels: '1',
      interim_results: 'true', endpointing: '300', utterance_end_ms: '1500', vad_events: 'true',
    })
    expect(url.searchParams.getAll('keyterm')).toEqual(['mainnet', 'Answered HQ'])
  })
})

describe('AudioClock', () => {
  it('maps audio time to wall time across a gap in the audio', () => {
    const clock = { t: 1_000_000 }
    const audio = new AudioClock(() => clock.t)
    audio.push(32_000) // 1 s of audio handed over at t
    clock.t += 30_000 // glasses were away for 30 s
    audio.push(32_000)
    expect(audio.toWall(0.5)).toBe(1_000_500)
    expect(audio.toWall(1.25)).toBe(1_030_250)
  })
})

describe('speech pipeline with a fake Deepgram', () => {
  it('authenticates, streams audio, and stores final segments with session timestamps', async () => {
    const fake = await fakeDeepgram()
    const t = await appWithFake(fake)
    for (let i = 0; i < 10; i++) t.speech.audio(frame())
    await until(() => fake.state.audioBytes === 32_000)
    expect(fake.state.auth).toEqual(['Token dg-test-key'])
    expect(fake.state.urls[0]!.searchParams.getAll('keyterm')).toEqual(['mainnet', 'Answered HQ'])

    fake.interim('Mainnet ships')
    fake.final('Mainnet ships in Q1.', 0, 1)
    fake.utteranceEnd(1)
    await until(() => t.events.some((e) => e.type === 'utterance_end'))

    expect(t.events.map((e) => e.type)).toEqual(['interim', 'segment', 'utterance_end'])
    const seg = t.speech.segments(t.session.id)
    expect(seg).toHaveLength(1)
    expect(seg[0]!.text).toBe('Mainnet ships in Q1.')
    expect(seg[0]!.startS).toBeGreaterThanOrEqual(0)
    expect(seg[0]!.startS).toBeLessThan(2)
    expect(seg[0]!.endS).toBeGreaterThanOrEqual(seg[0]!.startS)
  })

  it('sends KeepAlive while the host is silent', async () => {
    const fake = await fakeDeepgram()
    const t = await appWithFake(fake, { keepAliveMs: 40 })
    t.speech.audio(frame())
    await until(() => fake.state.control.filter((c) => c === 'KeepAlive').length >= 2)
  })

  it('reconnects after a dropped stream and delivers the audio sent meanwhile', async () => {
    const fake = await fakeDeepgram()
    const t = await appWithFake(fake)
    t.speech.audio(frame())
    await until(() => fake.state.audioBytes === 3200)
    fake.drop()
    await new Promise((r) => setTimeout(r, 50))
    t.speech.audio(frame()) // sent while disconnected: kept in the backlog
    await until(() => fake.state.connections === 2 && fake.state.audioBytes === 6400)
  })

  it('stops retrying when Deepgram refuses the key', async () => {
    const fake = await fakeDeepgram({ status: 401 })
    const t = await appWithFake(fake)
    t.speech.audio(frame())
    await new Promise((r) => setTimeout(r, 1500))
    expect(fake.state.connections).toBe(0)
  })

  it('closes the stream and deletes the transcript when the session ends', async () => {
    const fake = await fakeDeepgram()
    const t = await appWithFake(fake)
    t.speech.audio(frame())
    await until(() => fake.state.audioBytes > 0)
    fake.final('Testnet opens in December.', 0, 0.1)
    await until(() => t.speech.segments(t.session.id).length === 1)

    t.sessions.end(-100)
    await until(() => fake.state.control.includes('CloseStream'))
    expect(t.speech.segments(t.session.id)).toEqual([])
  })

  it('drops audio when no session is live, and when no key is configured', async () => {
    const fake = await fakeDeepgram()
    const t = await appWithFake(fake)
    t.sessions.end(-100)
    t.speech.audio(frame())
    await new Promise((r) => setTimeout(r, 100))
    expect(fake.state.connections).toBe(0)

    const off = await buildApp(loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: ':memory:' }))
    closers.push(() => off.app.close())
    off.sessions.start({ chatId: -1, chatTitle: 'G', host: { tgUserId: 1, name: 'H' } })
    expect(off.speech.enabled).toBe(false)
    expect(() => off.speech.audio(frame())).not.toThrow()
  })
})

describe('WAV fixture', () => {
  it('reads host.wav as G2-format PCM', () => {
    const pcm = readPcmWav(fileURLToPath(new URL('../../../fixtures/host.wav', import.meta.url)))
    expect(pcm.length / 32_000).toBeCloseTo(27.6, 0)
  })
})
