import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import type { Screen } from '@answered/protocol'
import { openDb } from '../src/db/index.js'
import { SessionService } from '../src/sessions.js'
import { ClaudeClassifier, FallbackClassifier, HeuristicClassifier, type Classifier, type ClassifyInput } from '../src/pipeline/classifier.js'
import { ClusterStore, type Classification } from '../src/pipeline/clusters.js'
import { Pipeline, QueuePublisher, sessionClock } from '../src/pipeline/index.js'
import { loadFixtures, score, type FixtureMessage } from '../src/pipeline/evaluate.js'
import { rank, score as rankScore } from '../src/pipeline/rank.js'
import { clampTitle, mightBeQuestion, pickTitle } from '../src/pipeline/text.js'

const FIXTURES = loadFixtures(fileURLToPath(new URL('../../../fixtures/questions.json', import.meta.url)))
const CHAT = -100
const log = pino({ level: 'silent' })

const TITLES: Record<string, string> = {
  mainnet: 'When is mainnet launching?',
  unlock: 'When do tokens unlock?',
  staking: 'Will mainnet have staking at launch?',
  bridge: 'Will there be a testnet-to-mainnet bridge?',
  cliff: 'Are unlocks linear or a single cliff?',
}

/** Answers like a perfect model would, from the fixture labels: the plumbing under test, not the model. */
class ScriptedClassifier implements Classifier {
  readonly name = 'scripted'
  calls: ClassifyInput[] = []
  constructor(private readonly labelOf: (text: string) => string | null) {}
  async classify(input: ClassifyInput): Promise<Classification[]> {
    this.calls.push(input)
    return input.messages.map((m) => {
      const label = this.labelOf(m.text)
      if (!label) return { messageId: m.id, isQuestion: false, spam: false, canonical: '', cluster: '' }
      if (label === 'spam') return { messageId: m.id, isQuestion: true, spam: true, canonical: '', cluster: '' }
      const existing = input.clusters.find((c) => c.title === TITLES[label])
      return { messageId: m.id, isQuestion: true, spam: false, canonical: TITLES[label]!, cluster: existing?.id ?? `new:${label}` }
    })
  }
}

const fixtureLabel = (text: string) => FIXTURES.find((f) => f.text === text)?.expect ?? null

function setup(classifier: Classifier = new ScriptedClassifier(fixtureLabel)) {
  const clock = { t: 1_800_000_000_000 }
  const now = () => clock.t
  const db = openDb(':memory:')
  const sessions = new SessionService(db, now)
  const store = new ClusterStore(db, now)
  const shown: Screen[] = []
  const publisher = new QueuePublisher({ store, sessions, show: (s) => shown.push(s), now })
  const pipeline = new Pipeline({ classifier, store, sessions, log, batchMs: 10_000, onQueueChanged: (id) => publisher.changed(id) })
  const { session } = sessions.start({ chatId: CHAT, chatTitle: 'Builders Hub', host: { tgUserId: 1, name: 'Host' } })
  let messageId = 1
  const capture = (m: Pick<FixtureMessage, 'user' | 'name' | 'text'>) => {
    const id = messageId++
    clock.t += 750 // the spec's burst: 40 messages over 30 s
    sessions.capture(CHAT, { messageId: id, userId: m.user, userName: m.name, text: m.text, at: clock.t })
    return id
  }
  const outcomes = (ids: number[]) =>
    ids.map((id) => {
      const r = db.prepare('SELECT is_question, spam, cluster_id FROM messages WHERE chat_id = ? AND message_id = ?').get(CHAT, id) as {
        is_question: number | null
        spam: number
        cluster_id: string | null
      }
      return { isQuestion: r.is_question === 1, spam: r.spam === 1, clusterId: r.cluster_id }
    })
  return { db, sessions, store, publisher, pipeline, session, clock, shown, capture, outcomes }
}

describe('text rules', () => {
  it('prefilter passes question shapes and drops chatter', () => {
    for (const q of ['wen mainnet ser??', 'Any update on the mainnet date?', 'is mainnet still coming this year', 'anyone know the unlock date', 'seriously when is mainnet']) {
      expect(mightBeQuestion(q)).toBe(true)
    }
    for (const c of ['gm gm', 'lol same', '/live', 'LFG this project is going to the moon', 'ok?', "Can't wait for this"]) {
      expect(mightBeQuestion(c)).toBe(false)
    }
  })

  it('titles fit a 64-character list item next to "99 | "', () => {
    const long = 'When exactly is the mainnet launch going to happen for the community and early backers?'
    expect(clampTitle(long).length).toBeLessThanOrEqual(56)
    expect(clampTitle(long).endsWith('...')).toBe(true)
    // Earliest with 4+ words, so later narrow variants don't take over the title.
    expect(pickTitle(['Mainnet?', 'When will mainnet launch for everyone?', 'Is mainnet Q1 or Q2?'])).toBe('When will mainnet launch for everyone?')
    expect(pickTitle(['Mainnet?', 'Wen?'])).toBe('Mainnet?')
  })
})

describe('ranking', () => {
  const c = (id: string, askers: number, votes: number, lastAskAt: number, firstAskAt = 0) => ({ id, title: id, askers, votes, lastAskAt, firstAskAt })

  it('scores 2 x askers + votes + 3 for a recent ask', () => {
    expect(rankScore(c('a', 4, 2, 1000), 1000 + 60_000)).toBe(13)
    expect(rankScore(c('a', 4, 2, 1000), 1000 + 180_000)).toBe(10)
  })

  it('orders by score, then askers, then who asked first', () => {
    const now = 10_000_000
    const ranked = rank([c('late', 2, 0, 0, 5), c('votes', 1, 2, 0, 1), c('early', 2, 0, 0, 1), c('hot', 2, 0, now)], now)
    expect(ranked.map((x) => x.id)).toEqual(['hot', 'early', 'late', 'votes'])
  })
})

describe('pipeline on the 40-message fixture', () => {
  it('detects, merges and ranks in batches of at most 10', async () => {
    const classifier = new ScriptedClassifier(fixtureLabel)
    const t = setup(classifier)
    const ids = FIXTURES.map((f) => t.capture(f))
    await t.pipeline.flush(t.session.id)

    const card = score(FIXTURES, t.outcomes(ids))
    expect(card).toMatchObject({ detection: 1, merged: 1, falseMerges: 0, falsePositives: 0, spamCaught: 2, clusters: 5 })

    // The prefilter keeps chatter away from the model; batches stay within 30 messages.
    const sent = classifier.calls.flatMap((c) => c.messages.map((m) => m.text))
    expect(sent).not.toContain('gm gm')
    expect(classifier.calls.every((c) => c.messages.length <= 10)).toBe(true)

    const ranked = t.store.ranked(t.session.id)
    expect(ranked.map((c) => [c.title, c.askers])).toEqual([
      ['When is mainnet launching?', 13], // 14 asks, Chen asked twice
      ['When do tokens unlock?', 9],
      ['Will mainnet have staking at launch?', 1],
      ['Will there be a testnet-to-mainnet bridge?', 1],
      ['Are unlocks linear or a single cliff?', 1],
    ])
  })

  it('pushes the top 5 to the glasses', async () => {
    const t = setup()
    FIXTURES.forEach((f) => t.capture(f))
    await t.pipeline.flush(t.session.id)
    const queue = t.publisher.screen(t.session.id)!
    expect(queue).toMatchObject({ view: 'queue', open: 5, group: 'Builders Hub' })
    if (queue.view !== 'queue') throw new Error()
    // 14 asks from 13 people (Chen asked twice): the glasses show asks, the spec's "14 asked".
    expect(queue.items[0]).toMatchObject({ n: 14, title: 'When is mainnet launching?' })
    for (const item of queue.items) expect(`${item.n} | ${item.title}`.length).toBeLessThanOrEqual(64)
  })

  it('moves an edited message to its new question', async () => {
    const t = setup()
    const id = t.capture({ user: 1, name: 'A', text: 'When is mainnet launching?' })
    t.capture({ user: 2, name: 'B', text: 'wen mainnet ser??' })
    await t.pipeline.flush(t.session.id)
    expect(t.store.ranked(t.session.id)[0]!.askers).toBe(2)

    t.sessions.edit(CHAT, id, 'When do tokens unlock?', t.clock.t)
    t.pipeline.edited(t.session.id, CHAT, id)
    await t.pipeline.flush(t.session.id)
    expect(t.store.ranked(t.session.id).map((c) => [c.title, c.askers])).toEqual([
      ['When do tokens unlock?', 1],
      ['When is mainnet launching?', 1],
    ])
  })

  it('counts one vote per non-asker and removes it when the reaction goes', async () => {
    const t = setup()
    const q = t.capture({ user: 1, name: 'A', text: 'When is mainnet launching?' })
    const q2 = t.capture({ user: 2, name: 'B', text: 'wen mainnet ser??' })
    await t.pipeline.flush(t.session.id)
    const cluster = t.store.ranked(t.session.id)[0]!.id

    t.store.react(CHAT, q, 50, true)
    t.store.react(CHAT, q2, 50, true) // same person, other message in the cluster: still one vote
    t.store.react(CHAT, q, 2, true) // an asker: already counted twice as an asker
    expect(t.store.get(cluster)!.votes).toBe(1)
    t.store.react(CHAT, q, 50, false)
    expect(t.store.get(cluster)!.votes).toBe(1) // still reacting on q2
    t.store.react(CHAT, q2, 50, false)
    expect(t.store.get(cluster)!.votes).toBe(0)

    t.store.setAnonymousReactions(CHAT, q, 4)
    expect(t.store.get(cluster)!.votes).toBe(4)
  })

  it('drops the batch if the session ends while the model is working', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const inner = new ScriptedClassifier(fixtureLabel)
    const slow: Classifier = { name: 'slow', classify: async (i) => (await gate, inner.classify(i)) }
    const t = setup(slow)
    t.capture({ user: 1, name: 'A', text: 'When is mainnet launching?' })
    const running = t.pipeline.flush(t.session.id)
    t.sessions.end(CHAT)
    release()
    await running
    expect(t.db.prepare('SELECT COUNT(*) AS n FROM clusters').get()).toEqual({ n: 0 })
  })

  it('never loops on messages a classifier leaves out', async () => {
    const lazy: Classifier = { name: 'lazy', classify: async () => [] }
    const t = setup(lazy)
    const id = t.capture({ user: 1, name: 'A', text: 'When is mainnet launching?' })
    await t.pipeline.flush(t.session.id)
    expect(t.outcomes([id])[0]).toMatchObject({ isQuestion: false })
  })
})

describe('QueuePublisher', () => {
  it('rebuilds at most every 5 s and only when the list changes', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const t = setup()
      const shown: Screen[] = []
      const publisher = new QueuePublisher({ store: t.store, sessions: t.sessions, show: (s) => shown.push(s) })
      t.capture({ user: 1, name: 'A', text: 'When is mainnet launching?' })
      await t.pipeline.flush(t.session.id)

      publisher.changed(t.session.id)
      expect(shown).toHaveLength(1) // first push is immediate

      t.capture({ user: 2, name: 'B', text: 'wen mainnet ser??' })
      await t.pipeline.flush(t.session.id)
      publisher.changed(t.session.id)
      publisher.changed(t.session.id)
      expect(shown).toHaveLength(1) // throttled

      vi.advanceTimersByTime(5000)
      expect(shown).toHaveLength(2) // one rebuild for both changes
      if (shown[1]!.view === 'queue') expect(shown[1]!.items[0]!.n).toBe(2)

      vi.advanceTimersByTime(10_000)
      publisher.changed(t.session.id)
      expect(shown).toHaveLength(2) // nothing changed, nothing sent
    } finally {
      vi.useRealTimers()
    }
  })

  it('formats the session clock', () => {
    expect(sessionClock(0, 61_000)).toBe('01:01')
    expect(sessionClock(0, 3_725_000)).toBe('1:02:05')
  })
})

describe('classifiers', () => {
  it('heuristic: no chatter becomes a question and link spam is caught', async () => {
    const t = setup(new HeuristicClassifier())
    const ids = FIXTURES.map((f) => t.capture(f))
    await t.pipeline.flush(t.session.id)
    const card = score(FIXTURES, t.outcomes(ids))
    // "Where can I read the docs? Never mind, found them" fools keyword rules; the model handles it.
    expect(card.falsePositives).toBeLessThanOrEqual(1)
    expect(card.spamCaught).toBe(2)
    expect(card.detection).toBeGreaterThan(0.9)
  })

  it('fallback covers a failing primary and anything it left out', async () => {
    const failing: Classifier = { name: 'down', classify: async () => Promise.reject(new Error('overloaded')) }
    const partial: Classifier = {
      name: 'partial',
      classify: async (i) => [{ messageId: i.messages[0]!.id, isQuestion: true, spam: false, canonical: 'Q?', cluster: 'new:a' }],
    }
    const input = { clusters: [], messages: [{ id: 1, text: 'When is mainnet?', isReply: false }, { id: 2, text: 'When do tokens unlock?', isReply: false }] }
    expect(await new FallbackClassifier(failing, new HeuristicClassifier(), log).classify(input)).toHaveLength(2)
    const merged = await new FallbackClassifier(partial, new HeuristicClassifier(), log).classify(input)
    expect(merged.map((r) => r.messageId).sort()).toEqual([1, 2])
    expect(merged.find((r) => r.messageId === 1)!.canonical).toBe('Q?')
  })

  /** Fake Messages API: answers the classify call and the verify call from canned JSON. */
  function fakeClaude(classify: unknown, verify: unknown) {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      requests.push({ url: String(url), body })
      const isVerify = String(body.system).startsWith('You check whether')
      return new Response(
        JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
          content: [{ type: 'text', text: JSON.stringify(isVerify ? verify : classify) }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return { requests, classifier: new ClaudeClassifier('sk-test', 'claude-haiku-5-5', 'https://api.anthropic.com', fetch) }
  }
  const clusters = [{ id: 'c_abc', title: 'When do tokens unlock?', status: 'open' as const }]

  it('Claude: one structured-output request to Haiku with thinking off, then a check of each join', async () => {
    const { requests, classifier } = fakeClaude(
      { results: [{ id: 7, is_question: true, spam: false, canonical: 'When do tokens unlock?', cluster: 'c_abc' }] },
      { pairs: [{ id: 7, same: true }] },
    )
    const out = await classifier.classify({ clusters, messages: [{ id: 7, text: 'unlock when', isReply: false }] })

    expect(out).toEqual([{ messageId: 7, isQuestion: true, spam: false, canonical: 'When do tokens unlock?', cluster: 'c_abc' }])
    expect(requests).toHaveLength(2)
    expect(requests[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(requests[0]!.body).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, output_config: { effort: 'low' } })
    expect((requests[0]!.body.output_config as { format: { type: string } }).format.type).toBe('json_schema')
    expect(JSON.parse((requests[1]!.body.messages as Array<{ content: string }>)[0]!.content)).toEqual({
      pairs: [{ id: 7, a: 'When do tokens unlock?', b: 'unlock when' }],
    })
  })

  it('Claude: a join the check rejects starts a new cluster', async () => {
    const { classifier } = fakeClaude(
      { results: [{ id: 8, is_question: true, spam: false, canonical: 'Are unlocks linear?', cluster: 'c_abc' }] },
      { pairs: [{ id: 8, same: false }] },
    )
    const out = await classifier.classify({ clusters, messages: [{ id: 8, text: 'linear or cliff?', isReply: false }] })
    expect(out[0]!.cluster).toBe('new:split-8')
  })

  it('Claude: no join, no second call', async () => {
    const { requests, classifier } = fakeClaude(
      { results: [{ id: 9, is_question: true, spam: false, canonical: 'Staking at launch?', cluster: 'new:staking' }] },
      { pairs: [] },
    )
    await classifier.classify({ clusters, messages: [{ id: 9, text: 'staking at launch?', isReply: false }] })
    expect(requests).toHaveLength(1)
  })
})
