import type {
  Account,
  AccountHealthResult,
  AdminSession,
  ApiKeyRecord,
  AuditEvent,
  DashboardData,
  DeepSeekLinkSession,
  GatewaySettings,
  MaintenanceStatus,
  Overview,
  Provider,
  RequestActivity,
} from './types'

let csrfToken = ''

interface ApiErrorShape {
  error?: {
    message?: string
    code?: string
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body) headers.set('Content-Type', 'application/json')
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) {
    headers.set('X-CSRF-Token', csrfToken)
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'include',
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as ApiErrorShape
    throw new ApiError(
      payload.error?.message ?? 'İşlem tamamlanamadı.',
      response.status,
      payload.error?.code,
    )
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export async function getSession(): Promise<AdminSession> {
  try {
    const session = await request<AdminSession & { csrfToken?: string }>('/admin/api/session')
    csrfToken = session.csrfToken ?? ''
    return {
      authenticated: session.authenticated,
      expiresAt: session.expiresAt,
    }
  } catch {
    csrfToken = ''
    return { authenticated: false }
  }
}

export async function login(token: string): Promise<void> {
  const session = await request<{ csrfToken: string }>('/admin/api/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
  csrfToken = session.csrfToken
}

export async function logout(): Promise<void> {
  await request('/admin/api/logout', { method: 'POST' })
  csrfToken = ''
}

export async function loadDashboard(): Promise<DashboardData> {
  const [overview, providers, accounts, apiKeys, activity, audit, settings, maintenance] = await Promise.all([
    request<Overview>('/admin/api/overview'),
    request<Provider[]>('/admin/api/providers'),
    request<Account[]>('/admin/api/accounts'),
    request<ApiKeyRecord[]>('/admin/api/api-keys'),
    request<RequestActivity[]>('/admin/api/activity?limit=100'),
    request<AuditEvent[]>('/admin/api/audit?limit=80'),
    request<GatewaySettings>('/admin/api/settings'),
    request<MaintenanceStatus>('/admin/api/maintenance'),
  ])
  return { overview, providers, accounts, apiKeys, activity, audit, settings, maintenance }
}

export function createAccount(input: {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
  dailyLimit?: number
}): Promise<Account> {
  return request('/admin/api/accounts', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function validateAccountCredentials(input: {
  providerId: string
  credentials: Record<string, string>
}): Promise<AccountHealthResult> {
  return request('/admin/api/accounts/validate-credentials', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function startDeepSeekLink(input: {
  name: string
  email?: string
  dailyLimit?: number
}): Promise<DeepSeekLinkSession & {
  connectorCode: string
  nativeConnectorCode: string
}> {
  return request('/admin/api/deepseek-link/sessions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function getDeepSeekLink(id: string): Promise<DeepSeekLinkSession> {
  return request(`/admin/api/deepseek-link/sessions/${encodeURIComponent(id)}`)
}

export function cancelDeepSeekLink(id: string): Promise<void> {
  return request(`/admin/api/deepseek-link/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function updateAccount(
  id: string,
  input: Partial<Pick<Account, 'name' | 'email' | 'status'>>
    & { dailyLimit?: number | null; credentials?: Record<string, string> },
): Promise<Account> {
  return request(`/admin/api/accounts/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function deleteAccount(id: string): Promise<void> {
  return request(`/admin/api/accounts/${id}`, { method: 'DELETE' })
}

export function testAccount(id: string): Promise<AccountHealthResult> {
  return request(`/admin/api/accounts/${id}/test`, { method: 'POST' })
}

export function createApiKey(input: {
  name: string
  scopes: Array<'chat' | 'models'>
  modelAllowlist: string[]
  requestsPerMinute: number
  dailyQuota: number
  expiresAt?: number
  allowedCidrs: string[]
}): Promise<{ rawKey: string; record: ApiKeyRecord }> {
  return request('/admin/api/api-keys', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateApiKey(
  id: string,
  input: Partial<Pick<
    ApiKeyRecord,
    'enabled' | 'modelAllowlist' | 'requestsPerMinute' | 'dailyQuota' | 'allowedCidrs'
  >> & { expiresAt?: number | null },
): Promise<ApiKeyRecord> {
  return request(`/admin/api/api-keys/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function rotateApiKey(
  id: string,
  input: { gracePeriodMinutes: number; expiresAt?: number },
): Promise<{ rawKey: string; record: ApiKeyRecord }> {
  return request(`/admin/api/api-keys/${id}/rotate`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function deleteApiKey(id: string): Promise<void> {
  return request(`/admin/api/api-keys/${id}`, { method: 'DELETE' })
}

export async function downloadAuditCsv(): Promise<void> {
  const response = await fetch('/admin/api/audit/export.csv', {
    credentials: 'include',
  })
  if (!response.ok) {
    throw new ApiError('Audit dışa aktarılamadı.', response.status)
  }
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `chat2api-audit-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function updateSettings(
  input: Pick<GatewaySettings, 'loadBalanceStrategy'>,
): Promise<GatewaySettings> {
  return request('/admin/api/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}
