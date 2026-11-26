import { describe, expect, it } from 'vitest'
import { Outbox, retryAfterSeconds } from '../src/telegram/outbox.js'

/** Fake clock: sleeping advances time instantly, so tests cover minutes in milliseconds. */
function fakeTime() {
  const clock = { t: 0 }
  return {
    clock,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += ms
    },
  }
}

describe('Outbox', () => {
  it('spaces calls at least 1 s apart in one chat', async () => {
    const time = fakeTime()
    const outbox = new Outbox(time)
    const sentAt: number[] = []
    await Promise.all([1, 2, 3].map(() => outbox.enqueue(1, async () => sentAt.push(time.now()))))
    expect(sentAt).toEqual([0, 1000, 2000])
  })

  it('never sends more than 18 calls in any rolling minute', async () => {
    const time = fakeTime()
    const outbox = new Outbox(time)
    const sentAt: number[] = []
    await Promise.all(Array.from({ length: 40 }, () => outbox.enqueue(1, async () => sentAt.push(time.now()))))
    expect(sentAt).toHaveLength(40)
    for (let i = 0; i < sentAt.length; i++) {
      const inWindow = sentAt.filter((t) => t > sentAt[i]! - 60_000 && t <= sentAt[i]!).length
      expect(inWindow).toBeLessThanOrEqual(18)
    }
    // The 19th call waits for the first to leave the window.
    expect(sentAt[18]).toBe(60_000)
  })

  it('sends replies before queued reactions', async () => {
    const time = fakeTime()
    const outbox = new Outbox(time)
    const order: string[] = []
    const reactions = Array.from({ length: 3 }, (_, i) =>
      outbox.enqueue(1, async () => order.push(`react${i}`), { priority: 'low' }),
    )
    const reply = outbox.enqueue(1, async () => order.push('reply'), { priority: 'high' })
    await Promise.all([...reactions, reply])
    // react0 was already running when the reply arrived; the reply jumps the rest.
    expect(order).toEqual(['react0', 'reply', 'react1', 'react2'])
  })

  it('keeps chats independent', async () => {
    const time = fakeTime()
    const outbox = new Outbox(time)
    const log: Array<[number, number]> = []
    await Promise.all([
      outbox.enqueue(1, async () => log.push([1, time.now()])),
      outbox.enqueue(2, async () => log.push([2, time.now()])),
    ])
    expect(log).toEqual([
      [1, 0],
      [2, 0],
    ])
  })

  it('waits retry_after on a 429 and retries the same call', async () => {
    const time = fakeTime()
    const limited: number[] = []
    const outbox = new Outbox({ ...time, onRateLimited: (i) => limited.push(i.retryAfterS) })
    let calls = 0
    const result = await outbox.enqueue(1, async () => {
      calls += 1
      if (calls === 1) throw { error_code: 429, parameters: { retry_after: 7 } }
      return time.now()
    })
    expect(calls).toBe(2)
    expect(result).toBe(7000)
    expect(limited).toEqual([7])
  })

  it('rejects other errors without blocking the queue', async () => {
    const time = fakeTime()
    const outbox = new Outbox(time)
    const failing = outbox.enqueue(1, async () => {
      throw new Error('message to reply not found')
    })
    const next = outbox.enqueue(1, async () => 'ok')
    await expect(failing).rejects.toThrow('not found')
    await expect(next).resolves.toBe('ok')
  })

  it('gives up after maxAttempts 429s', async () => {
    const time = fakeTime()
    const outbox = new Outbox({ ...time, maxAttempts: 3 })
    let calls = 0
    await expect(
      outbox.enqueue(1, async () => {
        calls += 1
        throw { error_code: 429, parameters: { retry_after: 1 } }
      }),
    ).rejects.toMatchObject({ error_code: 429 })
    expect(calls).toBe(3)
  })
})

describe('retryAfterSeconds', () => {
  it('reads grammY-shaped errors', () => {
    expect(retryAfterSeconds({ error_code: 429, parameters: { retry_after: 3 } })).toBe(3)
    expect(retryAfterSeconds({ error_code: 429 })).toBe(5)
    expect(retryAfterSeconds({ error_code: 400 })).toBeUndefined()
    expect(retryAfterSeconds(new Error('x'))).toBeUndefined()
  })
})
