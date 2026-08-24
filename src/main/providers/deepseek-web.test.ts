import { describe, expect, it } from 'vitest'
import { inspectDeepSeekCurrentUser } from './deepseek-web.js'

describe('DeepSeek current-user response inspection', () => {
  it('accepts only a successful response carrying an access token', () => {
    expect(inspectDeepSeekCurrentUser({
      code: 0,
      data: {
        biz_code: 0,
        biz_data: { token: 'short-lived-access-token' },
      },
    })).toEqual({
      kind: 'valid',
      accessToken: 'short-lived-access-token',
    })
  })

  it('captures the provider identity without requiring an email address', () => {
    expect(inspectDeepSeekCurrentUser({
      code: 0,
      data: {
        biz_code: 0,
        biz_data: {
          id: 'provider-user-id',
          token: 'short-lived-access-token',
        },
      },
    })).toEqual({
      kind: 'valid',
      accessToken: 'short-lived-access-token',
      providerIdentity: 'provider-user-id',
    })
  })

  it('recognizes authentication errors embedded in HTTP 200 payloads', () => {
    expect(inspectDeepSeekCurrentUser({
      code: 40_003,
      msg: 'Authorization Failed',
      data: {},
    })).toEqual({ kind: 'authentication_error' })
    expect(inspectDeepSeekCurrentUser({
      code: 0,
      data: { biz_code: 40_003 },
    })).toEqual({ kind: 'authentication_error' })
  })

  it('recognizes a provider suspension without exposing the access token', () => {
    expect(inspectDeepSeekCurrentUser({
      code: 0,
      data: {
        biz_code: 0,
        biz_data: {
          token: 'short-lived-access-token',
          chat: {
            is_muted: 1,
            mute_until: 1_800_000_000.125,
          },
        },
      },
    })).toEqual({
      kind: 'suspended',
      suspendedUntil: 1_800_000_000_125,
    })
  })

  it('fails closed when the provider response no longer proves access', () => {
    expect(inspectDeepSeekCurrentUser({
      code: 0,
      data: { biz_code: 0, biz_data: { id: 'user-id' } },
    })).toEqual({ kind: 'protocol_error' })
    expect(inspectDeepSeekCurrentUser(null)).toEqual({ kind: 'protocol_error' })
  })
})
