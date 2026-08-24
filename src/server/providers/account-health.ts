import { createHmac } from 'node:crypto'
import axios, { AxiosError, type AxiosRequestConfig } from 'axios'
import {
  DEEPSEEK_CURRENT_USER_ENDPOINT,
  DEEPSEEK_WEB_HEADERS,
  inspectDeepSeekCurrentUser,
} from '../../main/providers/deepseek-web.js'
import type { Account, Provider } from '../../main/store/types.js'

export type AccountHealthStatus =
  | 'healthy'
  | 'authentication_error'
  | 'rate_limited'
  | 'suspended'
  | 'unavailable'
  | 'unsupported'

export interface AccountHealthResult {
  healthy: boolean
  status: AccountHealthStatus
  code: string
  message: string
  checkedAt: number
  latencyMs: number
  retryAt?: number
  identityFingerprint?: string
}

type HealthHttpGet = (
  url: string,
  config: AxiosRequestConfig,
) => Promise<{ status: number; data?: unknown }>

function identityFingerprint(
  providerId: string,
  identity: string | undefined,
  key: Buffer | undefined,
): string | undefined {
  if (!identity || !key) return undefined
  return createHmac('sha256', key)
    .update(providerId)
    .update('\0')
    .update(identity)
    .digest('base64url')
}

function result(
  startedAt: number,
  input: Omit<AccountHealthResult, 'checkedAt' | 'latencyMs'>,
): AccountHealthResult {
  return {
    ...input,
    checkedAt: Date.now(),
    latencyMs: Date.now() - startedAt,
  }
}

function fromStatus(startedAt: number, status: number): AccountHealthResult {
  if (status === 401 || status === 403) {
    return result(startedAt, {
      healthy: false,
      status: 'authentication_error',
      code: 'provider_authentication_failed',
      message: 'Provider credential is invalid or expired.',
    })
  }
  if (status === 429) {
    return result(startedAt, {
      healthy: false,
      status: 'rate_limited',
      code: 'provider_rate_limited',
      message: 'Provider accepted the credential but is currently rate limited.',
    })
  }
  return result(startedAt, {
    healthy: false,
    status: 'unavailable',
    code: 'provider_unavailable',
    message: 'Provider health check could not be completed.',
  })
}

export async function checkProviderAccount(
  provider: Provider,
  account: Account,
  httpGet: HealthHttpGet = (url, config) => axios.get(url, config),
  identityHashKey?: Buffer,
): Promise<AccountHealthResult> {
  const startedAt = Date.now()

  try {
    if (provider.id === 'deepseek') {
      const token = account.credentials.token
      if (!token) return fromStatus(startedAt, 401)
      const response = await httpGet(DEEPSEEK_CURRENT_USER_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${token}`,
          ...DEEPSEEK_WEB_HEADERS,
        },
        timeout: 10_000,
        validateStatus: () => true,
      })
      if (response.status !== 200) return fromStatus(startedAt, response.status)
      const inspection = inspectDeepSeekCurrentUser(response.data)
      if (inspection.kind === 'authentication_error') return fromStatus(startedAt, 401)
      if (inspection.kind === 'suspended') {
        const fingerprint = identityFingerprint(
          provider.id,
          inspection.providerIdentity,
          identityHashKey,
        )
        return result(startedAt, {
          healthy: false,
          status: 'suspended',
          code: 'provider_account_suspended',
          message: 'The DeepSeek account is temporarily suspended by the provider.',
          ...(fingerprint === undefined ? {} : { identityFingerprint: fingerprint }),
          ...(inspection.suspendedUntil === undefined
            ? {}
            : { retryAt: inspection.suspendedUntil }),
        })
      }
      if (inspection.kind !== 'valid') {
        return result(startedAt, {
          healthy: false,
          status: 'unavailable',
          code: 'provider_protocol_changed',
          message: 'Provider session response could not be verified.',
        })
      }

      const fingerprint = identityFingerprint(
        provider.id,
        inspection.providerIdentity,
        identityHashKey,
      )
      return result(startedAt, {
        healthy: true,
        status: 'healthy',
        code: 'provider_healthy',
        message: 'DeepSeek web session is valid.',
        ...(fingerprint === undefined ? {} : { identityFingerprint: fingerprint }),
      })
    }

  } catch (cause) {
    if (cause instanceof AxiosError && cause.response?.status) {
      return fromStatus(startedAt, cause.response.status)
    }
    const message = cause instanceof Error ? cause.message.toLowerCase() : ''
    if (message.includes('invalid or expired') || message.includes('http 401') || message.includes('http 403')) {
      return fromStatus(startedAt, 401)
    }
    if (message.includes('http 429') || message.includes('rate limit')) {
      return fromStatus(startedAt, 429)
    }
    return fromStatus(startedAt, 503)
  }

  return result(startedAt, {
    healthy: false,
    status: 'unsupported',
    code: 'health_check_unsupported',
    message: 'This provider does not expose a safe credential-only health check.',
  })
}

export type AccountHealthChecker = (
  provider: Provider,
  account: Account,
) => Promise<AccountHealthResult>
