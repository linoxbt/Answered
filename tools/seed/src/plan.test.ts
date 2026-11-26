import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { loadFixtures, plan } from './plan.js'

const fixtures = loadFixtures(fileURLToPath(new URL('../../../fixtures/questions.json', import.meta.url)))

describe('seed plan', () => {
  it('spreads the 40-message burst over about 30 s', () => {
    const p = plan(fixtures, 3)
    expect(p).toHaveLength(40)
    expect(p[0]!.at).toBe(0)
    expect(p.at(-1)!.at).toBeGreaterThanOrEqual(30_000)
    expect(p.at(-1)!.at).toBeLessThan(32_000)
  })

  it('never has one account post twice within 1.1 s', () => {
    for (const accounts of [1, 2, 3, 6]) {
      const p = plan(fixtures, accounts)
      for (let a = 0; a < accounts; a++) {
        const times = p.filter((m) => m.account === a).map((m) => m.at)
        for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1100)
      }
    }
  })

  it('stretches the burst when one account has to post everything', () => {
    expect(plan(fixtures, 1).at(-1)!.at).toBe(39 * 1100)
  })
})
