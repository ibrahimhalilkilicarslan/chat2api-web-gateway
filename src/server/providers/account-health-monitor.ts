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

export interface AccountHealthMonitorOptions {
  intervalMs: number
  checker?: AccountHealthChecker
  registry?: AccountHealthRegistry
  store?: AccountHealthStore
  onError?: (error: Error) => void
}

export async function runAccountHealthChecks(
  options: Omit<AccountHealthMonitorOptions, 'intervalMs' | 'onError'> = {},
): Promise<number> {
  const store = options.store ?? storeManager
  const checker = options.checker ?? checkProviderAccount
  const registry = options.registry ?? accountHealthRegistry
  const provider = store.getProviderById('deepseek')
  if (!provider) return 0

  const accounts = store
    .getAccountsByProviderId('deepseek', true)
    .filter((account) => account.status !== 'inactive')

  for (const account of accounts) {
    const health = await checker(provider, account)
    registry.record(account.id, health)

    if (health.healthy) {
      store.updateAccount(account.id, {
        status: 'active',
        errorMessage: undefined,
      })
      continue
    }

    if (health.status === 'authentication_error') {
      store.updateAccount(account.id, {
        status: 'error',
        errorMessage: health.message,
      })
    }
  }

  return accounts.length
}

export function startAccountHealthMonitor(
  options: AccountHealthMonitorOptions,
): () => void {
  if (options.intervalMs <= 0) return () => undefined

  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void runAccountHealthChecks(options)
        .catch((cause) => {
          const error = cause instanceof Error ? cause : new Error('Account health check failed')
          options.onError?.(error)
        })
        .finally(schedule)
    }, options.intervalMs)
    timer.unref()
  }

  schedule()

  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
