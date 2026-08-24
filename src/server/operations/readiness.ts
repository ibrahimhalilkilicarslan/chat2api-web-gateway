import type { SafeRequestLog } from '../../main/store/store.js'
import type { AccountHealthResult } from '../providers/account-health.js'

export type OperationalReadinessStatus =
  | 'operational'
  | 'degraded'
  | 'blocked'
  | 'needs_check'

export type OperationalReadinessReason =
  | 'ready'
  | 'no_active_account'
  | 'credential_check_required'
  | 'no_successful_request'
  | 'provider_rate_limited'
  | 'provider_account_suspended'
  | 'provider_authentication_failed'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_protocol_changed'
  | 'no_available_account'
  | 'account_queue_timeout'
  | 'account_usage_window_exhausted'

export interface OperationalReadiness {
  status: OperationalReadinessStatus
  reasonCode: OperationalReadinessReason
  activeAccountCount: number
  healthyAccountCount: number
  openCircuitCount: number
  latestSuccessAt?: number
  latestProviderErrorAt?: number
  latestProviderErrorCode?: string
  retryAt?: number
}

interface ReadinessAccount {
  id: string
  status: 'active' | 'inactive' | 'expired' | 'error'
  health?: AccountHealthResult
}

interface ReadinessCircuit {
  accountId: string
  openedUntil: number
}

interface ReadinessInput {
  accounts: ReadinessAccount[]
  openCircuits: ReadinessCircuit[]
  requestLogs: SafeRequestLog[]
  now?: number
}

const PROVIDER_FAILURE_CODES = new Set<OperationalReadinessReason>([
  'provider_rate_limited',
  'provider_account_suspended',
  'provider_authentication_failed',
  'provider_unavailable',
  'provider_timeout',
  'provider_protocol_changed',
  'no_available_account',
  'account_queue_timeout',
  'account_usage_window_exhausted',
])

const RECENT_FAILURE_WINDOW_MS = 15 * 60_000

export function deriveOperationalReadiness(input: ReadinessInput): OperationalReadiness {
  const now = input.now ?? Date.now()
  const activeAccounts = input.accounts.filter((account) => account.status === 'active')
  const healthyAccounts = activeAccounts.filter((account) => account.health?.healthy)
  const activeIds = new Set(activeAccounts.map((account) => account.id))
  const activeCircuits = input.openCircuits.filter(
    (circuit) => activeIds.has(circuit.accountId) && circuit.openedUntil > now,
  )
  const latestSuccess = input.requestLogs.find((entry) => entry.status === 'success')
  const latestProviderError = input.requestLogs.find(
    (entry) => entry.status === 'error'
      && entry.errorCode
      && PROVIDER_FAILURE_CODES.has(entry.errorCode as OperationalReadinessReason),
  )
  const latestProviderErrorIsCurrent = Boolean(
    latestProviderError
      && latestProviderError.timestamp >= now - RECENT_FAILURE_WINDOW_MS
      && (!latestSuccess || latestProviderError.timestamp > latestSuccess.timestamp),
  )
  const suspendedAccount = input.accounts.find(
    (account) => account.health?.code === 'provider_account_suspended',
  )

  const base = {
    activeAccountCount: activeAccounts.length,
    healthyAccountCount: healthyAccounts.length,
    openCircuitCount: activeCircuits.length,
    ...(latestSuccess ? { latestSuccessAt: latestSuccess.timestamp } : {}),
    ...(latestProviderError
      ? {
          latestProviderErrorAt: latestProviderError.timestamp,
          latestProviderErrorCode: latestProviderError.errorCode,
        }
      : {}),
  }

  if (activeAccounts.length === 0) {
    return {
      ...base,
      status: 'blocked',
      reasonCode: suspendedAccount
        ? 'provider_account_suspended'
        : 'no_active_account',
      ...(suspendedAccount?.health?.retryAt === undefined
        ? {}
        : { retryAt: suspendedAccount.health.retryAt }),
    }
  }

  if (activeCircuits.length === activeAccounts.length) {
    return {
      ...base,
      status: 'blocked',
      reasonCode: normalizeFailureReason(latestProviderError?.errorCode),
      retryAt: Math.min(...activeCircuits.map((circuit) => circuit.openedUntil)),
    }
  }

  if (latestProviderErrorIsCurrent) {
    return {
      ...base,
      status: 'degraded',
      reasonCode: normalizeFailureReason(latestProviderError?.errorCode),
      ...(activeCircuits.length > 0
        ? { retryAt: Math.min(...activeCircuits.map((circuit) => circuit.openedUntil)) }
        : {}),
    }
  }

  if (activeAccounts.some((account) => !account.health)) {
    return {
      ...base,
      status: 'needs_check',
      reasonCode: 'credential_check_required',
    }
  }

  const unhealthyAccount = activeAccounts.find((account) => !account.health?.healthy)
  if (unhealthyAccount?.health) {
    return {
      ...base,
      status: 'degraded',
      reasonCode: normalizeFailureReason(unhealthyAccount.health.code),
    }
  }

  if (!latestSuccess) {
    return {
      ...base,
      status: 'needs_check',
      reasonCode: 'no_successful_request',
    }
  }

  return {
    ...base,
    status: 'operational',
    reasonCode: 'ready',
  }
}

function normalizeFailureReason(code: string | undefined): OperationalReadinessReason {
  return code && PROVIDER_FAILURE_CODES.has(code as OperationalReadinessReason)
    ? code as OperationalReadinessReason
    : 'provider_unavailable'
}
