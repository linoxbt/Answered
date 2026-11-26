import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { recapMessage, recapPage } from '../src/recap.js'
import type { RecapItem } from '../src/pipeline/clusters.js'
import type { Session } from '../src/sessions.js'

const session: Session = {
  id: 's_abc', hostId: 'h', chatId: -1001234567890, chatTitle: 'Builders <Hub>', chatUsername: null, status: 'ended',
  startedAt: 0, endedAt: 25 * 60_000 + 30_000, openingMessageId: null, recapMessageId: null,
}
const item = (over: Partial<RecapItem>): RecapItem => ({
  id: 'c', title: 'Q?', status: 'open', askers: 1, asks: 1, summary: null, offsetS: null, replyMessageId: null, manual: false, ...over,
})

describe('recap message', () => {
  it('lists answers in answer order with links, then what is still open', () => {
    const text = recapMessage(
      session,
      [
        item({ id: 'a', title: 'When do tokens unlock?', status: 'open', askers: 6, asks: 9 }),
        item({ id: 'b', title: 'When is mainnet launching?', status: 'answered', askers: 13, asks: 14, summary: 'Mainnet ships in Q1 & testnet in Dec.', offsetS: 754, replyMessageId: 77 }),
        item({ id: 'c', title: 'Bridge at launch?', status: 'answered', askers: 1, asks: 1, summary: 'Yes.', offsetS: 61, replyMessageId: 80 }),
        item({ id: 'd', title: 'Staking?', status: 'skipped' }),
      ],
      'https://x.test/recap/s_abc',
    )
    expect(text).toBe(
      [
        '<b>Q&amp;A recap: Builders &lt;Hub&gt;</b>',
        '2 of 4 questions answered in 25:30.',
        '',
        '1. <b>Bridge at launch?</b>',
        '   Yes. (<a href="https://t.me/c/1234567890/80">01:01</a>)',
        '2. <b>When is mainnet launching?</b> (14 asked)',
        '   Mainnet ships in Q1 &amp; testnet in Dec. (<a href="https://t.me/c/1234567890/77">12:34</a>)',
        '',
        '<b>Still open</b>',
        '- When do tokens unlock? (9 asked)',
        '- Staking?',
        '',
        '<a href="https://x.test/recap/s_abc">Full recap</a>',
      ].join('\n'),
    )
  })

  it('stays within Telegram\'s message limit', () => {
    const many = Array.from({ length: 200 }, (_, i) => item({ id: `q${i}`, title: `Question number ${i} about something long enough to matter?` }))
    const text = recapMessage(session, many)
    expect(text.length).toBeLessThanOrEqual(4096)
    expect(text).toContain('+185 more')
  })
})

describe('recap page', () => {
  it('shows questions, counts and answers, never names', () => {
    const html = recapPage(session, [item({ title: 'When?', status: 'answered', askers: 2, asks: 3, summary: 'Q1.', offsetS: 10 })])
    expect(html).toContain('<strong>When?</strong><span class="n">3 asked</span>')
    expect(html).toContain('Ended. 1 of 1 answered in 25:30.')
  })

  it('is served at /recap/:id and 404s for unknown ids', async () => {
    const t = await buildApp(loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: ':memory:' }))
    try {
      const { session: s } = t.sessions.start({ chatId: -1, chatTitle: 'G', host: { tgUserId: 1, name: 'Host Person' } })
      t.sessions.capture(-1, { messageId: 1, userId: 5, userName: 'Secret Asker', text: 'When?', at: Date.now() })
      t.store.apply(s.id, -1, [{ messageId: 1, isQuestion: true, spam: false, canonical: 'When is it?', cluster: 'new:a' }])
      const res = await t.app.inject({ url: `/recap/${s.id}` })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-type']).toContain('text/html')
      expect(res.body).toContain('When is it?')
      expect(res.body).not.toContain('Secret Asker')
      expect(res.body).not.toContain('Host Person')
      expect((await t.app.inject({ url: '/recap/s_nope' })).statusCode).toBe(404)
    } finally {
      await t.app.close()
    }
  })

  it('leaves flagged spam out', async () => {
    const t = await buildApp(loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL: ':memory:' }))
    try {
      const { session: s } = t.sessions.start({ chatId: -1, chatTitle: 'G', host: { tgUserId: 1, name: 'H' } })
      t.sessions.capture(-1, { messageId: 1, userId: 5, userName: 'A', text: 'airdrop?', at: Date.now() })
      t.store.apply(s.id, -1, [{ messageId: 1, isQuestion: true, spam: false, canonical: 'Airdrop?', cluster: 'new:a' }])
      t.store.flag(t.store.ranked(s.id)[0]!.id)
      expect(t.store.recap(s.id)).toEqual([])
    } finally {
      await t.app.close()
    }
  })
})
