import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreManager } from '../../main/store/store.js'
import type { Account } from '../../main/store/types.js'
import { AccountHealthRegistry } from './account-health-registry.js'
import { runAccountHealthChecks } from './account-health-monitor.js'

describe('account health monitor', () => {
  let store: StoreManager
  let account: Account

  beforeEach(() => {
    store = new StoreManager()
    store.initialize({ databasePath: ':memory:', masterKey: Buffer.alloc(32, 13) })
    account = {
      id: randomUUID(),
      providerId: 'deepseek',
      name: 'Monitored account',
      credentials: { token: 'private-token' },
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    }
    store.addAccount(account)
  })

  afterEach(() => store.close())

  it('records health without exposing credentials and marks invalid sessions as error', async () => {
    const registry = new AccountHealthRegistry()
    const checker = vi.fn(async () => ({
      healthy: false,
      status: 'authentication_error' as const,
      code: 'provider_authentication_failed',
      message: 'Provider credential is invalid or expired.',
      checkedAt: Date.now(),
      latencyMs: 4,
    }))

    await runAccountHealthChecks({ store, registry, checker })

    expect(store.getAccountById(account.id)).toMatchObject({
      status: 'error',
      errorMessage: 'Provider credential is invalid or expired.',
    })
    expect(registry.get(account.id)).toMatchObject({
      status: 'authentication_error',
      code: 'provider_authentication_failed',
    })
    expect(JSON.stringify(registry.list())).not.toContain('private-token')
  })

  it('does not permanently disable an account for temporary throttling', async () => {
    const registry = new AccountHealthRegistry()
    await runAccountHealthChecks({
      store,
      registry,
      checker: async () => ({
        healthy: false,
        status: 'rate_limited',
        code: 'provider_rate_limited',
        message: 'Provider is temporarily rate limited.',
        checkedAt: Date.now(),
        latencyMs: 3,
      }),
    })

    expect(store.getAccountById(account.id)?.status).toBe('active')
    expect(registry.get(account.id)?.status).toBe('rate_limited')
  })
})
