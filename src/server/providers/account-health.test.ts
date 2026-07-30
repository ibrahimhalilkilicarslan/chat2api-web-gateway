import { describe, expect, it, vi } from 'vitest'
import type { Account, Provider } from '../../main/store/types.js'
import { checkProviderAccount } from './account-health.js'

function provider(id: string): Provider {
  return {
    id,
    name: id,
    type: 'builtin',
    authType: 'userToken',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
}

function account(providerId: string, credentials: Record<string, string>): Account {
  return {
    id: 'account-id',
    providerId,
    name: 'Health account',
    credentials,
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('provider account health', () => {
  it('checks the DeepSeek web token against the fixed account endpoint', async () => {
    const httpGet = vi.fn(async () => ({
      status: 200,
      data: { data: { biz_data: { token: 'short-lived-access-token' } } },
    }))
    const health = await checkProviderAccount(
      provider('deepseek'),
      account('deepseek', { token: 'web-session-token' }),
      httpGet,
    )

    expect(health).toMatchObject({
      healthy: true,
      status: 'healthy',
      code: 'provider_healthy',
    })
    expect(httpGet).toHaveBeenCalledWith(
      'https://chat.deepseek.com/api/v0/users/current',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer web-session-token',
        }),
      }),
    )
  })

  it('maps provider throttling without exposing an upstream payload', async () => {
    const health = await checkProviderAccount(
      provider('deepseek'),
      account('deepseek', { token: 'web-session-token' }),
      async () => ({ status: 429 }),
    )

    expect(health).toMatchObject({
      healthy: false,
      status: 'rate_limited',
      code: 'provider_rate_limited',
    })
    expect(JSON.stringify(health)).not.toContain('web-session-token')
  })

  it('does not probe arbitrary provider endpoints', async () => {
    const httpGet = vi.fn(async () => ({ status: 200 }))
    const health = await checkProviderAccount(
      provider('unknown-provider'),
      account('unknown-provider', { token: 'secret' }),
      httpGet,
    )

    expect(health.status).toBe('unsupported')
    expect(httpGet).not.toHaveBeenCalled()
  })
})
