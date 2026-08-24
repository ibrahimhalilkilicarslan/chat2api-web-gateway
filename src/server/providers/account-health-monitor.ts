import { storeManager } from '../../main/store/store.js'
import {
  checkProviderAccount,
  type AccountHealthChecker,
} from './account-health.js'
import {
  accountHealthRegistry,
  type AccountHealthRegistry,
} from './account-health-registry.js'

interface AccountHealthStore {
  getProviderById: typeof storeManager.getProviderById
  getAccountsByProviderId: typeof storeManager.getAccountsByProviderId
  updateAccount: typeof storeManager.updateAccount
}

export type AccountUnhealthyStatus = 'authentication_error' | 'suspended'

export interface AccountHealthMonitorOptions {
  intervalMs: number
  runImmediately?: boolean
  checker?: AccountHealthChecker
  registry?: AccountHealthRegistry
  store?: AccountHealthStore
  onError?: (error: Error) => void
  onHealthy?: (accountId: string) => void
  onUnhealthy?: (accountId: string, status: AccountUnhealthyStatus, message?: string) => void
  onRecovered?: (accountId: string) => void
}

interface AccountHealthRunOptions {
  checker?: AccountHealthChecker
  registry?: AccountHealthRegistry
  store?: AccountHealthStore
  accountIds?: readonly string[]
  respectRetryAt?: boolean
  onHealthy?: (accountId: string) => void
  onUnhealthy?: (accountId: string, status: AccountUnhealthyStatus, message?: string) => void
  onRecovered?: (accountId: string) => void
}

export interface AccountHealthMonitorController {
  checkNow: () => Promise<number>
  schedule: (accountId: string, retryAt?: number) => void
  stop: () => void
}

export async function runAccountHealthChecks(
  options: AccountHealthRunOptions = {},
): Promise<number> {
  const store = options.store ?? storeManager
  const checker = options.checker ?? checkProviderAccount
  const registry = options.registry ?? accountHealthRegistry
  const provider = store.getProviderById('deepseek')
  if (!provider) return 0

  const requestedIds = options.accountIds ? new Set(options.accountIds) : undefined
  const accounts = store
    .getAccountsByProviderId('deepseek', true)
    .filter((account) => account.status !== 'inactive')
    .filter((account) => !requestedIds || requestedIds.has(account.id))
    .filter((account) => {
      if (!options.respectRetryAt) return true
      const health = registry.get(account.id)
      return health?.status !== 'suspended'
        || health.retryAt === undefined
        || health.retryAt <= Date.now()
    })

  for (const account of accounts) {
    const health = await checker(provider, account)
    registry.record(account.id, health)

    if (health.healthy) {
      const wasError = account.status === 'error'
      store.updateAccount(account.id, {
        status: 'active',
        errorMessage: undefined,
      })
      options.onHealthy?.(account.id)
      // Fire recovery only on the error -> active transition, not on every
      // healthy check, so downstream alerting is not spammed.
      if (wasError) options.onRecovered?.(account.id)
      continue
    }

    if (health.status === 'authentication_error' || health.status === 'suspended') {
      const wasHealthy = account.status !== 'error'
      store.updateAccount(account.id, {
        status: 'error',
        errorMessage: health.message,
      })
      // Fire only on the healthy -> error transition so an operator is alerted
      // once when a token dies, not on every subsequent retry check.
      if (wasHealthy) options.onUnhealthy?.(account.id, health.status, health.message)
    }
  }

  return accounts.length
}

export function startAccountHealthMonitor(
  options: AccountHealthMonitorOptions,
): AccountHealthMonitorController {
  const scheduledChecks = new Map<string, { timer: NodeJS.Timeout; runAt: number }>()

  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const scheduleAccount = (accountId: string, retryAt?: number) => {
    if (stopped) return
    const fallbackDelay = options.intervalMs > 0 ? options.intervalMs : 15 * 60_000
    const runAt = retryAt === undefined
      ? Date.now() + fallbackDelay
      : Math.max(Date.now() + 1000, retryAt + 1000)
    const current = scheduledChecks.get(accountId)
    if (current && current.runAt <= runAt) return
    if (current) clearTimeout(current.timer)

    const accountTimer = setTimeout(() => {
      scheduledChecks.delete(accountId)
      void runAccountHealthChecks({
        checker: options.checker,
        registry: options.registry,
        store: options.store,
        accountIds: [accountId],
        onHealthy: options.onHealthy,
        onUnhealthy: options.onUnhealthy,
        onRecovered: options.onRecovered,
      })
        .then(() => {
          const health = (options.registry ?? accountHealthRegistry).get(accountId)
          if (health?.status === 'suspended') scheduleAccount(accountId, health.retryAt)
        })
        .catch((cause) => {
          const error = cause instanceof Error ? cause : new Error('Account health check failed')
          options.onError?.(error)
        })
    }, Math.max(1000, runAt - Date.now()))
    accountTimer.unref()
    scheduledChecks.set(accountId, { timer: accountTimer, runAt })
  }

  const runCheck = async (respectRetryAt: boolean): Promise<number> => {
    const checked = await runAccountHealthChecks({
      checker: options.checker,
      registry: options.registry,
      store: options.store,
      respectRetryAt,
      onHealthy: options.onHealthy,
      onUnhealthy: options.onUnhealthy,
      onRecovered: options.onRecovered,
    })
    const registry = options.registry ?? accountHealthRegistry
    for (const health of registry.list()) {
      if (health.status === 'suspended') scheduleAccount(health.accountId, health.retryAt)
    }
    return checked
  }
  const checkNow = (): Promise<number> => runCheck(false)

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void runCheck(true)
        .catch((cause) => {
          const error = cause instanceof Error ? cause : new Error('Account health check failed')
          options.onError?.(error)
        })
        .finally(schedule)
    }, options.intervalMs)
    timer.unref()
  }

  if (options.intervalMs > 0) schedule()
  if (options.runImmediately) {
    void checkNow().catch((cause) => {
      const error = cause instanceof Error ? cause : new Error('Account health check failed')
      options.onError?.(error)
    })
  }

  return {
    checkNow,
    schedule: scheduleAccount,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      for (const scheduled of scheduledChecks.values()) clearTimeout(scheduled.timer)
      scheduledChecks.clear()
    },
  }
}
