import { readFileSync } from 'node:fs'

export interface FixtureMessage {
  user: number
  name: string
  text: string
  expect: string | null
}

export interface PlannedMessage {
  /** Milliseconds after the start of the burst. */
  at: number
  /** Index of the Telegram account that posts it. */
  account: number
  text: string
  expect: string | null
}

export function loadFixtures(path: string): FixtureMessage[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { messages: FixtureMessage[] }).messages
}

/**
 * Spreads the fixture burst over `durationMs`, assigning messages to accounts round-robin and
 * delaying any message that would make one account post twice within `minGapMs` (Telegram flags
 * user accounts that post fast). With 40 messages over 30 s, 2 accounts already satisfy 1 msg/s.
 */
export function plan(messages: FixtureMessage[], accounts: number, durationMs = 30_000, minGapMs = 1100): PlannedMessage[] {
  if (accounts < 1) throw new Error('need at least one account')
  const step = messages.length > 1 ? durationMs / (messages.length - 1) : 0
  const lastAt = new Array<number>(accounts).fill(-Infinity)
  let clock = 0
  return messages.map((m, i) => {
    const account = i % accounts
    clock = Math.max(clock, Math.round(i * step), lastAt[account]! + minGapMs)
    lastAt[account] = clock
    return { at: clock, account, text: m.text, expect: m.expect }
  })
}
