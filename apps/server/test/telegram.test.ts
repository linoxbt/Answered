import { afterEach, describe, expect, it } from 'vitest'
import { Bot } from 'grammy'

import type { Update } from 'grammy/types'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { TEXT } from '../src/telegram/handlers.js'
import { Outbox } from '../src/telegram/outbox.js'

const SECRET = 'secret'
const GROUP = { id: -1001234567890, type: 'supergroup' as const, title: 'Builders Hub' }
const ADMIN = { id: 10, is_bot: false, first_name: 'Lino' }
const ADA = { id: 11, is_bot: false, first_name: 'Ada', last_name: 'L' }
const OTHER_BOT = { id: 99, is_bot: true, first_name: 'Spam', username: 'spam_bot' }
const ME: Bot['botInfo'] = {
  id: 42,
  is_bot: true,
  first_name: 'Answered',
  username: 'AnsweredHQBot',
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as Bot['botInfo']

interface ApiCall {
  method: string
  payload: Record<string, unknown>
  at: number
}

/** A bot whose Bot API calls are answered locally and recorded with the (fake) time they were made. */
function fakeBot(admins: number[], now: () => number) {
  const bot = new Bot('123:fake', { botInfo: ME })
  const calls: ApiCall[] = []
  let nextMessageId = 1000
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown>, at: now() })
    const p = payload as Record<string, unknown>
    switch (method) {
      case 'getChatMember':
        return { ok: true, result: { status: admins.includes(p.user_id as number) ? 'administrator' : 'member', user: { id: p.user_id } } } as never
      case 'sendMessage':
        return { ok: true, result: { message_id: nextMessageId++, date: 0, chat: GROUP, text: p.text } } as never
      default:
        return { ok: true, result: true } as never
    }
  })
  return { bot, calls }
}

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  while (closers.length) await closers.pop()!()
})

async function setup(admins = [ADMIN.id]) {
  const clock = { t: 1_800_000_000_000 }
  const { bot, calls } = fakeBot(admins, () => clock.t)
  const outbox = new Outbox({ now: () => clock.t, sleep: async (ms) => void (clock.t += ms) })
  const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: ':memory:', TG_WEBHOOK_SECRET: SECRET, GLASSES_DEV_TOKEN: 't' })
  const built = await buildApp(config, { bot, outbox, now: () => clock.t })
  closers.push(() => built.app.close())

  let updateId = 1
  let messageId = 1
  const post = async (update: Omit<Update, 'update_id'>) => {
    const res = await built.app.inject({
      method: 'POST',
      url: '/tg/webhook',
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: { update_id: updateId++, ...update },
    })
    expect(res.statusCode).toBe(200)
  }
  const say = (from: typeof ADMIN | typeof OTHER_BOT, text: string, extra: Record<string, unknown> = {}) => {
    const id = messageId++
    const isCommand = text.startsWith('/')
    return post({
      message: {
        message_id: id,
        date: Math.floor(clock.t / 1000),
        chat: GROUP,
        from,
        text,
        ...(isCommand ? { entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }] } : {}),
        ...extra,
      } as never,
    }).then(() => id)
  }
  const sent = () => calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text as string)
  const settled = async (n: number) => {
    for (let i = 0; i < 200 && sent().length < n; i++) await new Promise((r) => setTimeout(r, 2))
    expect(sent()).toHaveLength(n)
  }
  return { ...built, calls, post, say, sent, settled, clock }
}

describe('/live and /end', () => {
  it('refuses /live from a non-admin', async () => {
    const t = await setup()
    await t.say(ADA, '/live')
    await t.settled(1)
    expect(t.sent()).toEqual([TEXT.adminsOnly])
    expect(t.sessions.open(GROUP.id)).toBeUndefined()
  })

  it('starts a session, posts the opening message, and shows the queue on the glasses', async () => {
    const t = await setup()
    await t.say(ADMIN, '/live')
    await t.settled(1)
    expect(t.sent()).toEqual([TEXT.opening])

    const session = t.sessions.open(GROUP.id)!
    expect(session).toMatchObject({ status: 'live', chatTitle: 'Builders Hub', openingMessageId: 1000 })
    expect(t.hub.stats().screen).toBe('queue')
  })

  it('accepts /live@botname and does not start a second session', async () => {
    const t = await setup()
    await t.say(ADMIN, '/live@AnsweredHQBot')
    await t.say(ADMIN, '/live')
    await t.settled(2)
    expect(t.sent()).toEqual([TEXT.opening, TEXT.alreadyLive])
  })

  it('lets anonymous admins start a session without a member lookup', async () => {
    const t = await setup([])
    await t.say({ id: 1087968824, is_bot: true, first_name: 'Group', username: 'GroupAnonymousBot' }, '/live', {
      sender_chat: GROUP,
    })
    await t.settled(1)
    expect(t.sent()).toEqual([TEXT.opening])
    expect(t.calls.some((c) => c.method === 'getChatMember')).toBe(false)
  })

  it('captures questions while live, skipping commands, bots and pre-session chatter', async () => {
    const t = await setup()
    await t.say(ADA, 'before the session')
    await t.say(ADMIN, '/live')
    const q = await t.say(ADA, 'wen mainnet ser??')
    await t.say(OTHER_BOT, 'buy my token')
    await t.say(ADA, '/help')
    await t.post({
      edited_message: { message_id: q, date: 0, edit_date: 1, chat: GROUP, from: ADA, text: 'When is mainnet launching?' } as never,
    })

    const rows = t.db.prepare('SELECT user_id, user_name, text, edited_at FROM messages').all()
    expect(rows).toEqual([{ user_id: ADA.id, user_name: 'Ada L', text: 'When is mainnet launching?', edited_at: 1000 }])
  })

  it('ends the session, deletes raw messages, and shows the end screen', async () => {
    const t = await setup()
    await t.say(ADMIN, '/live')
    await t.say(ADA, 'When is mainnet?')
    await t.say(ADMIN, '/end')
    await t.settled(2)

    expect(t.sent()[1]).toMatch(/^<b>Q&amp;A recap: Builders Hub<\/b>\n0 of 1 questions answered/)
    expect(t.calls.some((c) => c.method === 'pinChatMessage')).toBe(true)
    expect(t.sessions.open(GROUP.id)).toBeUndefined()
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 })
    expect(t.hub.stats().screen).toBe('ended')
  })

  it('answers /end with a hint when nothing is live', async () => {
    const t = await setup()
    await t.say(ADMIN, '/end')
    await t.settled(1)
    expect(t.sent()).toEqual([TEXT.notLive])
  })
})

describe('bot membership', () => {
  const member = (status: string) => ({ user: ME, status }) as never

  it('asks to be made admin when added as a plain member, and says ready once promoted', async () => {
    const t = await setup()
    const change = (from: string, to: string) =>
      t.post({
        my_chat_member: { chat: GROUP, from: ADMIN, date: 0, old_chat_member: member(from), new_chat_member: member(to) } as never,
      })
    await change('left', 'member')
    await change('member', 'administrator')
    await t.settled(2)
    expect(t.sent()).toEqual([TEXT.addedNeedsAdmin, TEXT.promoted])
  })

  it('ends the live session when the bot is removed', async () => {
    const t = await setup()
    await t.say(ADMIN, '/live')
    await t.post({
      my_chat_member: { chat: GROUP, from: ADMIN, date: 0, old_chat_member: member('administrator'), new_chat_member: member('kicked') } as never,
    })
    expect(t.sessions.open(GROUP.id)).toBeUndefined()
  })
})

describe('supergroup migration', () => {
  it('moves the live session to the new chat id', async () => {
    const t = await setup()
    await t.say(ADMIN, '/live')
    await t.say(ADMIN, '', { migrate_to_chat_id: -1009999999999, text: undefined })
    expect(t.sessions.open(GROUP.id)).toBeUndefined()
    expect(t.sessions.open(-1009999999999)).toMatchObject({ status: 'live' })
  })
})

describe('rate limits', () => {
  it('keeps a burst of bot messages within 18 per minute', async () => {
    const t = await setup()
    // 25 non-admins try /live at once: 25 replies queued through the outbox.
    for (let i = 0; i < 25; i++) await t.say({ ...ADA, id: 100 + i }, '/live')
    await t.settled(25)
    const at = t.calls.filter((c) => c.method === 'sendMessage').map((c) => c.at)
    for (const time of at) {
      expect(at.filter((x) => x > time - 60_000 && x <= time).length).toBeLessThanOrEqual(18)
    }
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(1000)
  })
})

describe('questions to glasses (phase 2)', () => {
  it('turns group questions and reactions into a ranked queue on the glasses', async () => {
    const t = await setup()
    await t.say(ADMIN, '/live')
    const q1 = await t.say(ADA, 'When is mainnet launching?')
    await t.say({ ...ADA, id: 12, first_name: 'Bo' }, 'when is mainnet launching??')
    await t.say({ ...ADA, id: 13, first_name: 'Cy' }, 'What are the token unlock dates?')
    await t.say({ ...ADA, id: 14, first_name: 'Di' }, 'gm everyone')

    const reaction = (user: typeof ADA | typeof OTHER_BOT, on: boolean) =>
      t.post({
        message_reaction: {
          chat: GROUP, message_id: q1, user, date: 0,
          old_reaction: on ? [] : [{ type: 'emoji', emoji: '👍' }],
          new_reaction: on ? [{ type: 'emoji', emoji: '👍' }] : [],
        } as never,
      })
    await reaction({ ...ADA, id: 77, first_name: 'Voter' }, true)
    await reaction(OTHER_BOT, true) // bots never vote

    const session = t.sessions.open(GROUP.id)!
    await t.pipeline.flush(session.id)
    // Reactions that arrived before classification count once the message joins a cluster.
    const ranked = t.store.ranked(session.id)
    expect(ranked.map((c) => [c.askers, c.votes])).toEqual([
      [2, 1],
      [1, 0],
    ])
    const screen = t.publisher.screen(session.id)
    expect(screen).toMatchObject({ view: 'queue', open: 2 })
  })
})
