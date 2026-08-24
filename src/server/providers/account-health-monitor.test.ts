import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StoreManager } from '../../main/store/store.js'
import type { Account } from '../../main/store/types.js'
import { AccountHealthRegistry } from './account-health-registry.js'
import {
  runAccountHealthChecks,
  startAccountHealthMonitor,
} from './account-health-monitor.js'

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

  afterEach(() => {
    vi.useRealTimers()
    store.close()
  })

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

  it('removes a suspended provider account from active routing', async () => {
    const registry = new AccountHealthRegistry()
    await runAccountHealthChecks({
      store,
      registry,
      checker: async () => ({
        healthy: false,
        status: 'suspended',
        code: 'provider_account_suspended',
        message: 'The provider account is temporarily suspended.',
        checkedAt: Date.now(),
        latencyMs: 3,
        retryAt: Date.now() + 60_000,
      }),
    })

    expect(store.getAccountById(account.id)).toMatchObject({
      status: 'error',
      errorMessage: 'The provider account is temporarily suspended.',
    })
    expect(registry.get(account.id)?.status).toBe('suspended')
  })

  it('rechecks a suspended account at its provider retry time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T12:00:00.000Z'))
    store.updateAccount(account.id, {
      status: 'error',
      errorMessage: 'Temporarily suspended.',
    })
    const registry = new AccountHealthRegistry()
    const onHealthy = vi.fn()
    const checker = vi.fn(async () => ({
      healthy: true,
      status: 'healthy' as const,
      code: 'ok',
      message: 'Healthy.',
      checkedAt: Date.now(),
      latencyMs: 2,
    }))
    const monitor = startAccountHealthMonitor({
      intervalMs: 0,
      store,
      registry,
      checker,
      onHealthy,
    })

    monitor.schedule(account.id, Date.now() + 1000)
    await vi.advanceTimersByTimeAsync(2001)

    expect(checker).toHaveBeenCalledTimes(1)
    expect(store.getAccountById(account.id)?.status).toBe('active')
    expect(onHealthy).toHaveBeenCalledWith(account.id)
    monitor.stop()
  })

  it('hydrates persisted account health immediately after restart and keeps retry scheduling', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T06:00:00.000Z'))
    store.updateAccount(account.id, {
      status: 'error',
      errorMessage: 'Temporarily suspended.',
    })
    const registry = new AccountHealthRegistry()
    const retryAt = Date.now() + 60_000
    const checker = vi.fn()
      .mockResolvedValueOnce({
        healthy: false,
        status: 'suspended' as const,
        code: 'provider_account_suspended',
        message: 'The provider account is temporarily suspended.',
        checkedAt: Date.now(),
        latencyMs: 2,
        retryAt,
      })
      .mockResolvedValueOnce({
        healthy: true,
        status: 'healthy' as const,
        code: 'provider_healthy',
        message: 'Healthy.',
        checkedAt: Date.now(),
        latencyMs: 2,
      })
    const monitor = startAccountHealthMonitor({
      intervalMs: 0,
      runImmediately: true,
      store,
      registry,
      checker,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(checker).toHaveBeenCalledTimes(1)
    expect(registry.get(account.id)?.status).toBe('suspended')

    // Suspended retries deliberately run one second after the provider timestamp.
    await vi.advanceTimersByTimeAsync(61_001)
    expect(checker).toHaveBeenCalledTimes(2)
    expect(store.getAccountById(account.id)?.status).toBe('active')
    monitor.stop()
  })

  it('does not poll a suspended account before the provider retry time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T06:00:00.000Z'))
    const registry = new AccountHealthRegistry()
    const checker = vi.fn(async () => ({
      healthy: false,
      status: 'suspended' as const,
      code: 'provider_account_suspended',
      message: 'The provider account is temporarily suspended.',
      checkedAt: Date.now(),
      latencyMs: 2,
      retryAt: Date.now() + 60_000,
    }))
    const monitor = startAccountHealthMonitor({
      intervalMs: 10_000,
      runImmediately: true,
      store,
      registry,
      checker,
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(checker).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checker).toHaveBeenCalledTimes(1)
    monitor.stop()
  })

  it('fires onUnhealthy once on the healthy -> error transition', async () => {
    const registry = new AccountHealthRegistry()
    const onUnhealthy = vi.fn()
    const checker = vi.fn(async () => ({
      healthy: false,
      status: 'authentication_error' as const,
      code: 'provider_authentication_failed',
      message: 'Provider credential is invalid or expired.',
      checkedAt: Date.now(),
      latencyMs: 2,
    }))

    await runAccountHealthChecks({ store, registry, checker, onUnhealthy })
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
    expect(onUnhealthy).toHaveBeenCalledWith(
      account.id,
      'authentication_error',
      'Provider credential is invalid or expired.',
    )

    // A repeat check while the account is already errored must not re-alert.
    await runAccountHealthChecks({ store, registry, checker, onUnhealthy })
    expect(onUnhealthy).toHaveBeenCalledTimes(1)
  })

  it('fires onRecovered when an errored account becomes healthy again', async () => {
    store.updateAccount(account.id, { status: 'error', errorMessage: 'expired' })
    const registry = new AccountHealthRegistry()
    const onRecovered = vi.fn()
    const checker = vi.fn(async () => ({
      healthy: true,
      status: 'healthy' as const,
      code: 'provider_healthy',
      message: 'Healthy.',
      checkedAt: Date.now(),
      latencyMs: 2,
    }))

    await runAccountHealthChecks({ store, registry, checker, onRecovered })
    expect(onRecovered).toHaveBeenCalledWith(account.id)
    expect(store.getAccountById(account.id)?.status).toBe('active')
  })
})
