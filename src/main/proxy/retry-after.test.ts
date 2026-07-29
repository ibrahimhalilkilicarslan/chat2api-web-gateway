import { describe, expect, it } from 'vitest'
import { parseRetryAfterMs } from './retry-after.js'

describe('Retry-After parser', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('12')).toBe(12_000)
    expect(parseRetryAfterMs('0')).toBe(1000)
    expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:30 GMT')))
      .toBe(30_000)
  })

  it('rejects invalid values and caps excessive cooldowns', () => {
    expect(parseRetryAfterMs('not-a-date')).toBeUndefined()
    expect(parseRetryAfterMs(undefined)).toBeUndefined()
    expect(parseRetryAfterMs('999999')).toBe(15 * 60_000)
  })
})
