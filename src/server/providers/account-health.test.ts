import { describe, expect, it, vi } from 'vitest'
import type { Account, Provider } from '../../main/store/types.js'
import { checkProviderAccount } from './account-health.js'

function provider(id: string): Provider {
  return {
    id,
    name: id,
    type: 'builtin',
    authType: 'token',
    apiEndpoint: 'https://code-owned.example',
    headers: {},
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
  it('checks the official API against the fixed models endpoint', async () => {
    const httpGet = vi.fn(async () => ({ status: 200, data: { object: 'list', data: [] } }))
    const health = await checkProviderAccount(
      provider('deepseek-api'),
      account('deepseek-api', { apiKey: 'official-key' }),
      httpGet,
    )

    expect(health).toMatchObject({
      healthy: true,
      status: 'healthy',
      code: 'provider_healthy',
    })
    expect(httpGet).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer official-key',
        }),
      }),
    )
  })

  it('maps provider throttling without exposing an upstream payload', async () => {
    const health = await checkProviderAccount(
      provider('deepseek-api'),
      account('deepseek-api', { apiKey: 'official-key' }),
      async () => ({ status: 429 }),
    )

    expect(health).toMatchObject({
      healthy: false,
      status: 'rate_limited',
      code: 'provider_rate_limited',
    })
    expect(JSON.stringify(health)).not.toContain('official-key')
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
