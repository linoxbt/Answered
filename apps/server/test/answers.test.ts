import { afterEach, describe, expect, it } from 'vitest'
import { Bot } from 'grammy'
import type { Screen } from '@answered/protocol'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { normalizeTokens, quoteCoverage, rejection, type Judge, type JudgeQuestion, type Verdict } from '../src/answers/judge.js'
import { answerText, messageLink } from '../src/answers/writer.js'
import { Outbox } from '../src/telegram/outbox.js'
import type { TranscriberHandlers } from '../src/speech/types.js'

const CHAT = -1001234567890
const closers: Array<() => Promise<unknown>> = []
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

/** Answers like the real judge would, from a rule per question title. */
class ScriptedJudge implements Judge {
  readonly name = 'scripted'
  calls: Array<{ questions: JudgeQuestion[]; transcript: string }> = []
  constructor(private readonly rule: (q: JudgeQuestion, transcript: string) => Partial<Verdict> | null) {}
  async judge(input: { questions: JudgeQuestion[]; transcript: string }): Promise<Verdict[]> {
    this.calls.push(input)
    return input.questions.map((q) => {
      const v = this.rule(q, input.transcript)
      return { id: q.id, answered: Boolean(v), confidence: 0.9, summary: '', quote: '', ...v }
    })
  }
  async summarize(): Promise<string> {
    return 'Mainnet ships in Q1.'
  }
}

async function setup(judge: Judge) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  const bot = new Bot('1:x', { botInfo: { id: 42, is_bot: true, first_name: 'Answered', username: 'AnsweredHQBot' } as Bot['botInfo'] })
  let mid = 9000
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: method === 'sendMessage' ? { message_id: mid++, date: 0, chat: { id: CHAT, type: 'supergroup' } } : true } as never
  })
  const handlers: TranscriberHandlers[] = []
  const clock = { t: 0 }
  const outbox = new Outbox({ sleep: async (ms) => void (clock.t += ms), now: () => clock.t })
  const built = await buildApp(loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: ':memory:', GLASSES_DEV_TOKEN: 't' }), {
    bot,
    outbox,
    judge,
    undoMs: 60,
    flashMs: 40,
    transcriber: (h) => {
      handlers.push(h)
      return { send: () => {}, close: async () => {} }
    },
  })
  closers.push(() => built.app.close())
  const screens: Screen[] = []
  const show = built.hub.show.bind(built.hub)
  built.hub.show = (s) => {
    if (s) screens.push(s)
    show(s)
  }
  const { session } = built.sessions.start({ chatId: CHAT, chatTitle: 'Builders Hub', host: { tgUserId: 1, name: 'Host' } })

  let msg = 1
  const ask = (userId: number, name: string, text: string, canonical: string, cluster: string) => {
    const id = msg++
    built.sessions.capture(CHAT, { messageId: id, userId, userName: name, text, at: Date.now() })
    built.store.apply(session.id, CHAT, [{ messageId: id, isQuestion: true, spam: false, canonical, cluster: built.store.assignable(session.id).find((c) => c.title === canonical)?.id ?? `new:${cluster}` }])
    return id
  }
  /** The host says something, then pauses (final segment + UtteranceEnd). */
  const say = (text: string) => {
    built.speech.audio(Buffer.alloc(3200)) // opens the stream
    const h = handlers.at(-1)!
    const now = Date.now()
    h.onEvent({ type: 'final', text, startAt: now - 1000, endAt: now, words: [], speechFinal: true })
    h.onEvent({ type: 'utterance_end', at: now })
  }
  const sent = () => calls.filter((c) => c.method === 'sendMessage')
  const reactions = () => calls.filter((c) => c.method === 'setMessageReaction')
  const view = () => screens.at(-1)?.view
  return { ...built, session, calls, screens, ask, say, sent, reactions, view }
}

const MAINNET = 'When is mainnet launching?'
const UNLOCK = 'When do tokens unlock?'

const answersMainnet = (q: JudgeQuestion, t: string) =>
  q.title === MAINNET && /q one|q1/i.test(t) ? { summary: 'Mainnet ships in Q1, testnet in December.', quote: 'Mainnet ships in q one', confidence: 0.92 } : null

describe('answer loop', () => {
  it('take -> spoken answer -> undo window -> one threaded reply with mentions, then reactions', async () => {
    const judge = new ScriptedJudge(answersMainnet)
    const t = await setup(judge)
    const first = t.ask(11, 'Ada <3', 'wen mainnet', MAINNET, 'm')
    t.ask(12, 'Bo', 'mainnet date?', MAINNET, 'm')
    t.ask(13, 'Cy', 'unlock when?', UNLOCK, 'u')
    t.publisher.publishNow(t.session.id)

    expect(t.controller.input('press')).toBe(true) // takes the top question
    expect(t.view()).toBe('taking')
    await until(() => t.reactions().length === 1)
    expect(t.reactions()[0]!.payload).toMatchObject({ message_id: first, reaction: [{ type: 'emoji', emoji: '👀' }] })

    t.say('Great question. Mainnet ships in q one and the public testnet opens in December.')
    await until(() => t.view() === 'sending')
    // The judge saw the taken question and the other open one.
    expect(judge.calls[0]!.questions.map((q) => [q.title, q.taken])).toEqual([
      [MAINNET, true],
      [UNLOCK, false],
    ])
    expect(t.sent()).toHaveLength(0) // nothing posted during the undo window

    await until(() => t.sent().length === 1)
    const reply = t.sent()[0]!.payload
    expect(reply).toMatchObject({ chat_id: CHAT, parse_mode: 'HTML', reply_parameters: { message_id: first } })
    expect(reply.text).toMatch(/^<b>Answered at \d\d:\d\d:<\/b> Mainnet ships in Q1, testnet in December\./)
    expect(reply.text).toContain('<a href="tg://user?id=11">Ada &lt;3</a>, <a href="tg://user?id=12">Bo</a> (2 people asked this)')
    await until(() => t.reactions().filter((r) => (r.payload.reaction as Array<{ emoji: string }>)[0]!.emoji === '👍').length === 2)

    const mainnet = t.store.assignable(t.session.id).find((c) => c.title === MAINNET)!
    expect(mainnet.status).toBe('answered')
    expect(t.store.answer(mainnet.id)).toMatchObject({ summary: 'Mainnet ships in Q1, testnet in December.', replyMessageId: 9000 })
    expect(t.screens.some((s) => s.view === 'answered')).toBe(true)
    await until(() => t.view() === 'queue')
  })

  it('a question only talked around stays open', async () => {
    const t = await setup(new ScriptedJudge(answersMainnet))
    t.ask(13, 'Cy', 'unlock when?', UNLOCK, 'u')
    t.controller.input('press')
    t.say('On token unlocks, we care a lot about fairness, and we are working through the details.')
    await until(() => t.view() === 'still_open')
    await until(() => t.view() === 'taking') // back to the question after the flash
    expect(t.sent()).toHaveLength(0)
    expect(t.store.assignable(t.session.id)[0]!.status).toBe('taken')
  })

  it('rejects an "answered" verdict whose quote is not in the transcript', async () => {
    const liar = new ScriptedJudge((q) => (q.title === MAINNET ? { summary: 'Mainnet is in Q1.', quote: 'Mainnet launches in Q1 for sure', confidence: 0.99 } : null))
    const t = await setup(liar)
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.controller.input('press')
    t.say('We are excited about mainnet.')
    await until(() => t.view() === 'still_open')
    expect(t.sent()).toHaveLength(0)
  })

  it('a swipe during the undo window cancels the post', async () => {
    const t = await setup(new ScriptedJudge(answersMainnet))
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.controller.input('press')
    t.say('Mainnet ships in q one.')
    await until(() => t.view() === 'sending')
    t.controller.input('next')
    expect(t.view()).toBe('taking')
    await new Promise((r) => setTimeout(r, 150))
    expect(t.sent()).toHaveLength(0)
  })

  it('a press during the undo window posts at once', async () => {
    const t = await setup(new ScriptedJudge(answersMainnet))
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.controller.input('press')
    t.say('Mainnet ships in q one.')
    await until(() => t.view() === 'sending')
    t.controller.input('press')
    await until(() => t.sent().length === 1)
  })

  it('press while taking marks it answered by hand, with a summary from the transcript', async () => {
    const t = await setup(new ScriptedJudge(() => null))
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.controller.input('press')
    t.say('Something the judge did not accept.')
    await until(() => t.view() === 'still_open')
    t.controller.input('press') // skip the flash
    t.controller.input('press') // mark answered
    await until(() => t.sent().length === 1)
    expect(t.sent()[0]!.payload.text).toContain('Mainnet ships in Q1.')
    expect(t.store.assignable(t.session.id)[0]!.status).toBe('answered')
  })

  it('swipe skips the question; double-press puts it back', async () => {
    const t = await setup(new ScriptedJudge(() => null))
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.ask(13, 'Cy', 'unlock when?', UNLOCK, 'u')
    t.controller.input('press')
    t.controller.input('double')
    expect(t.view()).toBe('queue')
    expect(t.store.ranked(t.session.id)).toHaveLength(2)
    t.controller.input('press')
    t.controller.input('next')
    expect(t.store.ranked(t.session.id).map((c) => c.title)).toEqual([UNLOCK])
  })

  it('swipes in the queue move the selection that a press takes', async () => {
    const t = await setup(new ScriptedJudge(() => null))
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.ask(12, 'Bo', 'wen mainnet?', MAINNET, 'm')
    t.ask(13, 'Cy', 'unlock when?', UNLOCK, 'u')
    t.controller.input('next')
    expect(t.screens.at(-1)).toMatchObject({ view: 'queue', selected: 1 })
    t.controller.input('press')
    expect(t.screens.at(-1)).toMatchObject({ view: 'taking', title: UNLOCK })
  })

  it('posts an answer to another open question the host covered, and returns the taken one to the queue', async () => {
    const t = await setup(new ScriptedJudge(answersMainnet))
    t.ask(13, 'Cy', 'unlock when?', UNLOCK, 'u')
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.controller.input('press') // takes unlock (asked first)
    t.say('Mainnet ships in q one.')
    await until(() => t.sent().length === 1)
    const statuses = Object.fromEntries(t.store.assignable(t.session.id).map((c) => [c.title, c.status]))
    expect(statuses).toEqual({ [UNLOCK]: 'open', [MAINNET]: 'answered' })
  })

  it('answers a repeat of an answered question with the earlier answer and a link', async () => {
    const t = await setup(new ScriptedJudge(answersMainnet))
    t.ask(11, 'Ada', 'wen mainnet', MAINNET, 'm')
    t.controller.input('press')
    t.say('Mainnet ships in q one.')
    await until(() => t.sent().length === 1)

    // A latecomer asks again; the pipeline classifies it into the answered cluster.
    const cluster = t.store.assignable(t.session.id)[0]!
    t.sessions.capture(CHAT, { messageId: 50, userId: 20, userName: 'Late', text: 'when mainnet??', at: Date.now() })
    const pipeline = t.pipeline as unknown as { o: { classifier: { classify: unknown } } }
    pipeline.o.classifier.classify = async () => [{ messageId: 50, isQuestion: true, spam: false, canonical: MAINNET, cluster: cluster.id }]
    await t.pipeline.flush(t.session.id)
    await until(() => t.sent().length === 2)
    const repeat = t.sent()[1]!.payload
    expect(repeat).toMatchObject({ reply_parameters: { message_id: 50 } })
    expect(repeat.text).toContain('Answered earlier at')
    expect(repeat.text).toContain('https://t.me/c/1234567890/9000')
  })

  it('leaves gestures to the glasses when no session is live', async () => {
    const t = await setup(new ScriptedJudge(() => null))
    t.sessions.end(CHAT)
    expect(t.controller.input('double')).toBe(false)
  })
})

describe('quote check', () => {
  it('treats "q one", "Q 1" and "Q1" alike and ignores punctuation', () => {
    expect(normalizeTokens('Mainnet ships in Q1!')).toEqual(normalizeTokens('mainnet ships in q one'))
    expect(normalizeTokens('Q 1, testnet in December.')).toEqual(['q1', 'testnet', 'in', 'december'])
    expect(quoteCoverage('Mainnet ships in Q1', 'Great question. Mainnet ships in q one and the public testnet opens')).toBe(1)
    expect(quoteCoverage('Mainnet launches in Q1 for sure', 'We are excited about mainnet.')).toBeLessThan(0.5)
  })

  it('applies the confidence floor, stricter for questions the host did not take', () => {
    const v = { id: 'x', answered: true, confidence: 0.8, summary: 'Q1.', quote: 'ships in q one' }
    expect(rejection(v, true, 'mainnet ships in q one')).toBeNull()
    expect(rejection(v, false, 'mainnet ships in q one')).toMatch(/confidence/)
    expect(rejection({ ...v, summary: '' }, true, 'mainnet ships in q one')).toBe('no summary')
  })
})

describe('reply text', () => {
  it('caps mentions at 10, skips anonymous senders and escapes HTML', () => {
    const askers = [
      { userId: -100123, userName: 'Group admin' },
      ...Array.from({ length: 12 }, (_, i) => ({ userId: i + 1, userName: `U${i}` })),
    ]
    const text = answerText({ summary: 'A & B <soon>', offsetS: 754, askers })
    expect(text.startsWith('<b>Answered at 12:34:</b> A &amp; B &lt;soon&gt;')).toBe(true)
    expect(text.match(/tg:\/\/user/g)).toHaveLength(10)
    expect(text).toContain('+2 others (13 people asked this)')
    expect(text).not.toContain('-100123')
  })

  it('links messages in private supergroups and public groups', () => {
    expect(messageLink({ chatId: -1001234567890, chatUsername: null }, 7)).toBe('https://t.me/c/1234567890/7')
    expect(messageLink({ chatId: -1001234567890, chatUsername: 'buildershub' }, 7)).toBe('https://t.me/buildershub/7')
    expect(messageLink({ chatId: -5168349314, chatUsername: null }, 7)).toBeUndefined()
  })
})
