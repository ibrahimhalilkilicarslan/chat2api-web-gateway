import { describe, expect, it } from 'vitest'
import { isIpAllowed, isValidIpOrCidr } from './ip-allowlist.js'

describe('API key IP allowlist', () => {
  it('validates IPv4, IPv6 and CIDR entries', () => {
    expect(isValidIpOrCidr('203.0.113.8')).toBe(true)
    expect(isValidIpOrCidr('203.0.113.0/24')).toBe(true)
    expect(isValidIpOrCidr('2001:db8::/32')).toBe(true)
    expect(isValidIpOrCidr('203.0.113.0/33')).toBe(false)
    expect(isValidIpOrCidr('not-an-ip')).toBe(false)
  })

  it('allows exact and subnet matches while failing closed', () => {
    expect(isIpAllowed('203.0.113.8', ['203.0.113.8'])).toBe(true)
    expect(isIpAllowed('203.0.113.42', ['203.0.113.0/24'])).toBe(true)
    expect(isIpAllowed('203.0.114.42', ['203.0.113.0/24'])).toBe(false)
    expect(isIpAllowed('2001:db8::12', ['2001:db8::/32'])).toBe(true)
    expect(isIpAllowed('2001:db9::12', ['2001:db8::/32'])).toBe(false)
    expect(isIpAllowed('invalid', ['203.0.113.0/24'])).toBe(false)
  })

  it('treats an empty policy as unrestricted', () => {
    expect(isIpAllowed('198.51.100.10', [])).toBe(true)
  })
})
