import axios, { AxiosError, type AxiosRequestConfig } from 'axios'
import type { Account, Provider } from '../../main/store/types.js'

const DEEPSEEK_WEB_HEALTH_ENDPOINT = 'https://chat.deepseek.com/api/v0/users/current'

export type AccountHealthStatus =
  | 'healthy'
  | 'authentication_error'
  | 'rate_limited'
  | 'unavailable'
  | 'unsupported'

export interface AccountHealthResult {
  healthy: boolean
  status: AccountHealthStatus
  code: string
  message: string
  checkedAt: number
  latencyMs: number
}

type HealthHttpGet = (
  url: string,
  config: AxiosRequestConfig,
) => Promise<{ status: number; data?: unknown }>

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function hasDeepSeekWebAccessToken(value: unknown): boolean {
  const root = record(value)
  const data = record(root?.data)
  const bizData = record(data?.biz_data) ?? record(root?.biz_data)
  return typeof bizData?.token === 'string' && bizData.token.length > 0
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
): Promise<AccountHealthResult> {
  const startedAt = Date.now()

  try {
    if (provider.id === 'deepseek') {
      const token = account.credentials.token
      if (!token) return fromStatus(startedAt, 401)
      const response = await httpGet(DEEPSEEK_WEB_HEALTH_ENDPOINT, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          Origin: 'https://chat.deepseek.com',
          Referer: 'https://chat.deepseek.com/',
          'User-Agent': 'Chat2API-Web-Gateway/2.0',
        },
        timeout: 10_000,
        validateStatus: () => true,
      })
      if (response.status !== 200) return fromStatus(startedAt, response.status)
      if (!hasDeepSeekWebAccessToken(response.data)) return fromStatus(startedAt, 502)

      return result(startedAt, {
        healthy: true,
        status: 'healthy',
        code: 'provider_healthy',
        message: 'DeepSeek web session is valid.',
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

export type AccountHealthChecker = typeof checkProviderAccount
