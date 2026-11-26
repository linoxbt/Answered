import { describe, expect, it } from 'vitest'
import { parseClientMessage, toDisplayAscii } from './index.js'

describe('parseClientMessage', () => {
  it('accepts valid messages', () => {
    expect(parseClientMessage('{"t":"input","g":"press","src":"ring","idx":2}')).toEqual({ t: 'input', g: 'press', src: 'ring', idx: 2 })
    expect(parseClientMessage('{"t":"resume"}')).toEqual({ t: 'resume' })
    expect(parseClientMessage('{"t":"hello","app":"a","version":"1","mic":"phone"}')).toEqual({ t: 'hello', app: 'a', version: '1', mic: 'phone' })
  })

  it('drops unknown optional fields instead of trusting them', () => {
    expect(parseClientMessage('{"t":"input","g":"long","src":"nose","idx":"3"}')).toEqual({ t: 'input', g: 'long' })
  })

  it('rejects garbage', () => {
    for (const raw of ['', 'null', '[]', '{"t":"input"}', '{"t":"input","g":"wave"}', '{"t":"hello","app":1}', '{"t":"nope"}']) {
      expect(parseClientMessage(raw)).toBeNull()
    }
  })
})

describe('toDisplayAscii', () => {
  it('keeps plain ASCII and newlines', () => {
    expect(toDisplayAscii('14 | When mainnet?\n[OK]')).toBe('14 | When mainnet?\n[OK]')
  })

  it('maps typographic characters and drops the rest', () => {
    expect(toDisplayAscii('It’s “live” — now…')).toBe('It\'s "live" - now...')
    expect(toDisplayAscii('café ✓ 🚀')).toBe('cafe  ')
  })
})
