import type { AccountHealthResult } from './account-health.js'

export interface AccountHealthSnapshot extends AccountHealthResult {
  accountId: string
}

export class AccountHealthRegistry {
  private readonly snapshots = new Map<string, AccountHealthSnapshot>()

  record(accountId: string, result: AccountHealthResult): AccountHealthSnapshot {
    const snapshot = { accountId, ...result }
    this.snapshots.set(accountId, snapshot)
    return snapshot
  }

  get(accountId: string): AccountHealthSnapshot | undefined {
    return this.snapshots.get(accountId)
  }

  list(): AccountHealthSnapshot[] {
    return [...this.snapshots.values()].sort((left, right) => right.checkedAt - left.checkedAt)
  }

  delete(accountId: string): void {
    this.snapshots.delete(accountId)
  }

  clear(): void {
    this.snapshots.clear()
  }
}

export const accountHealthRegistry = new AccountHealthRegistry()
