import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { RuntimeConfig } from '../core/config.js'
import { storeManager } from '../main/store/store.js'
import { buildApp } from './app.js'
import type { AccountHealthChecker } from './providers/account-health.js'

const origin = 'http://gateway.test'
const bootstrapApiKey = 'bootstrap-api-key-that-is-at-least-thirty-two-characters'
const adminToken = 'admin-token-that-is-at-least-thirty-two-characters'
const accountHealthChecker: AccountHealthChecker = async (_provider, account) => (
  account.credentials.token?.startsWith('invalid-')
    ? {
        healthy: false,
        status: 'authentication_error',
        code: 'provider_authentication_failed',
        message: 'Provider credential is invalid or expired.',
        checkedAt: Date.now(),
        latencyMs: 4,
      }
    : {
        healthy: true,
        status: 'healthy',
        code: 'provider_healthy',
        message: 'Test provider credential is valid.',
        checkedAt: Date.now(),
        latencyMs: 4,
        identityFingerprint: account.credentials.token?.startsWith('duplicate-provider-identity-')
          ? 'duplicate-provider-identity'
          : account.credentials.token,
      }
)

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 8080,
  databasePath: ':memory:',
  logLevel: 'fatal',
  trustProxy: false,
  secureCookies: false,
  masterKey: Buffer.alloc(32, 17),
  bootstrapApiKey,
  adminToken,
  sessionSecret: 'session-secret-that-is-at-least-thirty-two-characters',
  adminOrigins: [origin],
  adminHosts: [],
  maxBodyBytes: 2 * 1024 * 1024,
  globalConcurrency: 5,
  accountConcurrency: 1,
  backgroundAccountReserve: 1,
  backgroundUsageReserve: 10,
  accountUsageWindowMs: 15 * 60_000,
  queueMaxDepth: 10,
  queueTimeoutMs: 1000,
  deepSeekSessionTtlMs: 300_000,
  rateLimitRpm: 20,
  dailyQuota: 100,
  requestTimeoutMs: 10_000,
  firstByteTimeoutMs: 1_000,
  streamIdleTimeoutMs: 1_000,
  accountHealthIntervalMs: 0,
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  return values.map((value) => value.split(';')[0]).join('; ')
}

describe('gateway HTTP security contract', () => {
  let app: FastifyInstance
  let cookies = ''
  let csrfToken = ''

  beforeAll(async () => {
    app = await buildApp(config, { accountHealthChecker })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('serves minimal health data with hardened headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
    expect(response.headers['x-content-type-options']).toBe('nosniff')
    expect(response.headers['referrer-policy']).toBe('no-referrer')
    expect(response.headers['content-security-policy']).toContain("font-src 'self' data:")
  })

  it('requires a Bearer key and rejects query-string credentials', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/models' })
    const query = await app.inject({
      method: 'GET',
      url: `/v1/models?api_key=${bootstrapApiKey}`,
    })
    const valid = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${bootstrapApiKey}` },
    })

    expect(missing.statusCode).toBe(401)
    expect(query.statusCode).toBe(401)
    expect(valid.statusCode).toBe(200)
  })

  it('rejects the legacy completions surface but accepts standard OpenAI chat fields', async () => {
    const legacy = await app.inject({
      method: 'POST',
      url: '/v1/completions',
      headers: { authorization: `Bearer ${bootstrapApiKey}` },
      payload: { model: 'deepseek-v4-flash', prompt: 'legacy' },
    })
    const compat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${bootstrapApiKey}` },
      payload: {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'hello' }],
        tools: [],
        temperature: 0.5,
        max_tokens: 64,
        response_format: { type: 'json_object' },
      },
    })

    expect(legacy.statusCode).toBe(404)
    // Standard OpenAI fields are accepted for drop-in compatibility, never
    // rejected as unsupported. Without a live account the request fails later
    // at routing, not at validation.
    expect(compat.statusCode).not.toBe(400)
    expect(compat.json()?.error?.code).not.toBe('unsupported_feature')
  })

  it('requires an exact admin origin and issues a signed session', async () => {
    const rejected = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      headers: { origin: 'https://untrusted.example' },
      payload: { token: adminToken },
    })
    expect(rejected.statusCode).toBe(403)

    const accepted = await app.inject({
      method: 'POST',
      url: '/admin/api/login',
      headers: { origin },
      payload: { token: adminToken },
    })
    const body = accepted.json<{ csrfToken: string }>()
    cookies = cookieHeader(accepted.headers['set-cookie'])
    csrfToken = body.csrfToken

    expect(accepted.statusCode).toBe(200)
    expect(cookies).toContain('c2a_admin=')
    expect(cookies).toContain('c2a_csrf=')
    expect(csrfToken.length).toBeGreaterThan(20)
  })

  it('reports daily and lifetime request success independently', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/admin/api/overview',
      headers: { cookie: cookies },
    })
    const body = response.json<{
      requests: {
        successRate: number
        todaySuccessRate: number
      }
    }>()

    expect(response.statusCode).toBe(200)
    expect(body.requests.successRate).toBeGreaterThanOrEqual(0)
    expect(body.requests.successRate).toBeLessThanOrEqual(1)
    expect(body.requests.todaySuccessRate).toBeGreaterThanOrEqual(0)
    expect(body.requests.todaySuccessRate).toBeLessThanOrEqual(1)
  })

  it('keeps deployment timeouts read-only and rejects ineffective settings', async () => {
    const settings = await app.inject({
      method: 'GET',
      url: '/admin/api/settings',
      headers: { cookie: cookies },
    })
    expect(settings.statusCode).toBe(200)
    expect(settings.json()).toMatchObject({
      requestTimeout: config.requestTimeoutMs,
      streamIdleTimeout: config.streamIdleTimeoutMs,
    })

    const rejected = await app.inject({
      method: 'PATCH',
      url: '/admin/api/settings',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { requestTimeout: 42_000 },
    })
    expect(rejected.statusCode).toBe(400)

    const accepted = await app.inject({
      method: 'PATCH',
      url: '/admin/api/settings',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { loadBalanceStrategy: 'least-used' },
    })
    expect(accepted.statusCode).toBe(200)
    expect(accepted.json()).toMatchObject({
      loadBalanceStrategy: 'least-used',
      requestTimeout: config.requestTimeoutMs,
    })
  })

  it('enforces CSRF and never returns provider credentials', async () => {
    const missingCsrf = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { origin, cookie: cookies },
      payload: {
        providerId: 'deepseek',
        name: 'Rejected account',
        credentials: { token: 'not-stored-without-csrf' },
      },
    })
    expect(missingCsrf.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        providerId: 'deepseek',
        name: 'Integration account',
        credentials: { token: 'provider-token-that-must-remain-private' },
      },
    })
    const account = created.json<Record<string, unknown>>()

    expect(created.statusCode).toBe(201)
    expect(account).not.toHaveProperty('credentials')
    expect(account).not.toHaveProperty('token')
    expect(JSON.stringify(account)).not.toContain('provider-token-that-must-remain-private')

    const stored = storeManager.getAccountById(String(account.id), true)
    expect(stored?.credentials.token).toBe('provider-token-that-must-remain-private')

    const rotated = await app.inject({
      method: 'PATCH',
      url: `/admin/api/accounts/${String(account.id)}`,
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        credentials: { token: 'rotated-provider-token-that-must-remain-private' },
      },
    })
    expect(rotated.statusCode).toBe(200)
    expect(JSON.stringify(rotated.json())).not.toContain('rotated-provider-token-that-must-remain-private')
    expect(storeManager.getAccountById(String(account.id), true)?.credentials.token)
      .toBe('rotated-provider-token-that-must-remain-private')

    const listed = await app.inject({
      method: 'GET',
      url: '/admin/api/accounts',
      headers: { cookie: cookies },
    })
    expect(JSON.stringify(listed.json())).not.toContain('provider-token-that-must-remain-private')
    expect(JSON.stringify(listed.json())).not.toContain('rotated-provider-token-that-must-remain-private')
  })

  it('preserves omitted account fields during partial updates', async () => {
    const accountId = '6d4c41c6-3be2-42c8-a802-e0c6c02efed4'
    const now = Date.now()
    storeManager.addAccount({
      id: accountId,
      providerId: 'deepseek',
      name: 'Partial update account',
      email: 'partial-update@example.com',
      credentials: { token: 'partial-update-provider-token' },
      status: 'active',
      dailyLimit: 50,
      createdAt: now,
      updatedAt: now,
    })

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/admin/api/accounts/${accountId}`,
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { status: 'inactive' },
    })

    expect(disabled.statusCode).toBe(200)
    expect(disabled.json()).toMatchObject({
      name: 'Partial update account',
      email: 'partial-update@example.com',
      status: 'inactive',
      dailyLimit: 50,
    })
    expect(storeManager.getAccountById(accountId, true)).toMatchObject({
      email: 'partial-update@example.com',
      dailyLimit: 50,
      credentials: { token: 'partial-update-provider-token' },
    })
  })

  it('rejects a second credential for an already registered provider identity', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        providerId: 'deepseek',
        name: 'First identity record',
        credentials: { token: 'duplicate-provider-identity-first-session' },
      },
    })
    const duplicate = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        providerId: 'deepseek',
        name: 'Duplicate identity record',
        credentials: { token: 'duplicate-provider-identity-second-session' },
      },
    })

    expect(first.statusCode).toBe(201)
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json()).toMatchObject({
      error: { code: 'duplicate_provider_identity' },
    })
    expect(JSON.stringify(duplicate.json())).not.toContain('second-session')
  })

  it('returns a generated API key once and stores only its hash', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/api-keys',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        name: 'Integration client',
        scopes: ['chat', 'models'],
        modelAllowlist: [],
        requestsPerMinute: 10,
        dailyQuota: 100,
      },
    })
    const body = created.json<{ rawKey: string }>()
    expect(created.statusCode).toBe(201)
    expect(body.rawKey).toMatch(/^c2a_/)

    const listed = await app.inject({
      method: 'GET',
      url: '/admin/api/api-keys',
      headers: { cookie: cookies },
    })
    const serialized = JSON.stringify(listed.json())
    expect(serialized).not.toContain(body.rawKey)
    expect(serialized).not.toContain('keyHash')
  })

  it('keeps model discovery outside chat burst and daily quotas', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/api-keys',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        name: 'Quota isolation client',
        scopes: ['chat', 'models'],
        modelAllowlist: [],
        requestsPerMinute: 2,
        dailyQuota: 1,
      },
    })
    const { rawKey } = created.json<{ rawKey: string }>()
    const headers = { authorization: `Bearer ${rawKey}` }

    const firstModels = await app.inject({ method: 'GET', url: '/v1/models', headers })
    const secondModels = await app.inject({ method: 'GET', url: '/v1/models', headers })
    const firstChat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { invalid: true },
    })
    const secondChat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { invalid: true },
    })

    expect(firstModels.statusCode).toBe(200)
    expect(secondModels.statusCode).toBe(200)
    expect(firstChat.statusCode).toBe(400)
    expect(secondChat.statusCode).toBe(429)
    expect(secondChat.json()).toMatchObject({ error: { code: 'daily_quota_exceeded' } })
  })

  it('enforces API key IP policy, expiry and zero-grace rotation', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/api-keys',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        name: 'Restricted integration client',
        scopes: ['chat', 'models'],
        modelAllowlist: ['deepseek-v4-flash'],
        requestsPerMinute: 10,
        dailyQuota: 100,
        allowedCidrs: ['203.0.113.0/24'],
        expiresAt: Date.now() + 60 * 60_000,
      },
    })
    const body = created.json<{ rawKey: string; record: { id: string } }>()
    expect(created.statusCode).toBe(201)

    const denied = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress: '198.51.100.10',
      headers: { authorization: `Bearer ${body.rawKey}` },
    })
    const allowed = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress: '203.0.113.10',
      headers: { authorization: `Bearer ${body.rawKey}` },
    })
    expect(denied.statusCode).toBe(401)
    expect(allowed.statusCode).toBe(200)

    const rotated = await app.inject({
      method: 'POST',
      url: `/admin/api/api-keys/${body.record.id}/rotate`,
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        gracePeriodMinutes: 0,
        expiresAt: Date.now() + 2 * 60 * 60_000,
      },
    })
    const rotatedBody = rotated.json<{ rawKey: string }>()
    expect(rotated.statusCode).toBe(201)
    expect(rotatedBody.rawKey).toMatch(/^c2a_/)

    const oldKey = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress: '203.0.113.10',
      headers: { authorization: `Bearer ${body.rawKey}` },
    })
    const newKey = await app.inject({
      method: 'GET',
      url: '/v1/models',
      remoteAddress: '203.0.113.10',
      headers: { authorization: `Bearer ${rotatedBody.rawKey}` },
    })
    expect(oldKey.statusCode).toBe(401)
    expect(newKey.statusCode).toBe(200)
  })

  it('exposes metadata-only maintenance and CSV audit exports', async () => {
    storeManager.addAuditLog({
      actor: '=HYPERLINK("https://untrusted.invalid")',
      action: 'gateway.settings.update',
      targetType: 'settings',
      outcome: 'success',
      metadata: {},
    })
    const maintenance = await app.inject({
      method: 'GET',
      url: '/admin/api/maintenance',
      headers: { cookie: cookies },
    })
    expect(maintenance.statusCode).toBe(200)
    expect(maintenance.json()).toMatchObject({
      integrity: 'ok',
      schemaVersion: 3,
      journalMode: 'memory',
    })
    expect(JSON.stringify(maintenance.json())).not.toContain('databasePath')

    const audit = await app.inject({
      method: 'GET',
      url: '/admin/api/audit/export.csv',
      headers: { cookie: cookies },
    })
    expect(audit.statusCode).toBe(200)
    expect(audit.headers['content-type']).toContain('text/csv')
    expect(audit.body).toContain('"admin"')
    expect(audit.body).toContain(`"'=HYPERLINK`)
    expect(audit.body).not.toContain('provider-token-that-must-remain-private')
  })

  it('tests provider credentials without returning or auditing the secret', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        providerId: 'deepseek',
        name: 'DeepSeek web health account',
        credentials: { token: 'web-provider-token-that-must-remain-private' },
      },
    })
    const account = created.json<{ id: string }>()

    const health = await app.inject({
      method: 'POST',
      url: `/admin/api/accounts/${account.id}/test`,
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
    })
    const serialized = JSON.stringify(health.json())

    expect(health.statusCode).toBe(200)
    expect(health.json()).toMatchObject({
      healthy: true,
      code: 'provider_healthy',
    })
    expect(serialized).not.toContain('web-provider-token-that-must-remain-private')
    const auditLogs = storeManager.listAuditLogs(20)
    expect(auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'account.health_check',
        outcome: 'success',
        metadata: {
          providerId: 'deepseek',
          healthCode: 'provider_healthy',
        },
      }),
    ]))
    expect(JSON.stringify(auditLogs)).not.toContain('web-provider-token-that-must-remain-private')
  })

  it('validates an unsaved credential without persisting or exposing it', async () => {
    const accountCount = storeManager.getAccounts().length
    const validated = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts/validate-credentials',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        providerId: 'deepseek',
        credentials: { token: 'Bearer preflight-token-that-must-remain-private' },
      },
    })
    const serialized = JSON.stringify(validated.json())

    expect(validated.statusCode).toBe(200)
    expect(validated.json()).toMatchObject({
      healthy: true,
      code: 'provider_healthy',
    })
    expect(storeManager.getAccounts()).toHaveLength(accountCount)
    expect(serialized).not.toContain('preflight-token-that-must-remain-private')
    const auditLogs = storeManager.listAuditLogs(20)
    expect(auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'account.credentials.validate',
        outcome: 'success',
        metadata: {
          providerId: 'deepseek',
          healthCode: 'provider_healthy',
        },
      }),
    ]))
    expect(JSON.stringify(auditLogs)).not.toContain('preflight-token-that-must-remain-private')
  })

  it('links a DeepSeek browser session through a short-lived origin-bound capability', async () => {
    const accountCount = storeManager.getAccounts().length
    const started = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/sessions',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        name: 'Browser-linked account',
        email: 'browser-linked@example.com',
        dailyLimit: 250,
      },
    })
    const link = started.json<{
      id: string
      status: string
      connectorCode: string
      nativeConnectorCode: string
      expiresAt: number
    }>()
    expect(started.statusCode).toBe(201)
    expect(link.status).toBe('waiting')
    expect(link.connectorCode).toMatch(/^c2a-ds-link-v1\./)
    expect(link.nativeConnectorCode).toMatch(/^c2a-ds-native-v1\./)

    const encoded = link.connectorCode.slice('c2a-ds-link-v1.'.length)
    const connector = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as {
      endpoint: string
      sessionId: string
      secret: string
    }
    expect(connector.endpoint).toBe(`${origin}/admin/api/deepseek-link/complete`)
    expect(connector.sessionId).toBe(link.id)
    const nativeConnector = JSON.parse(
      Buffer.from(
        link.nativeConnectorCode.slice('c2a-ds-native-v1.'.length),
        'base64url',
      ).toString('utf8'),
    ) as {
      endpoint: string
      sessionId: string
      secret: string
      transport: string
    }
    expect(nativeConnector).toMatchObject({
      endpoint: `${origin}/admin/api/deepseek-link/native-complete`,
      sessionId: link.id,
      transport: 'native',
    })
    expect(nativeConnector.secret).not.toBe(connector.secret)

    const token = 'browser-session-token-that-must-remain-private'
    const wrongOrigin = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/complete',
      headers: {
        origin: 'https://untrusted.example',
        'content-type': 'text/plain;charset=UTF-8',
      },
      payload: JSON.stringify({
        sessionId: connector.sessionId,
        secret: connector.secret,
        token,
      }),
    })
    expect(wrongOrigin.statusCode).toBe(403)

    const completed = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/complete',
      headers: {
        origin: 'https://chat.deepseek.com',
        'content-type': 'text/plain;charset=UTF-8',
      },
      payload: JSON.stringify({
        sessionId: connector.sessionId,
        secret: connector.secret,
        token,
      }),
    })
    const completedBody = completed.json<{ status: string; accountId: string }>()
    expect(completed.statusCode).toBe(201)
    expect(completed.headers['access-control-allow-origin']).toBe('https://chat.deepseek.com')
    expect(completedBody.status).toBe('complete')
    expect(JSON.stringify(completedBody)).not.toContain(token)
    expect(storeManager.getAccounts()).toHaveLength(accountCount + 1)
    expect(storeManager.getAccountById(completedBody.accountId, true)?.credentials.token).toBe(token)

    const status = await app.inject({
      method: 'GET',
      url: `/admin/api/deepseek-link/sessions/${link.id}`,
      headers: { cookie: cookies },
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({
      status: 'complete',
      accountId: completedBody.accountId,
    })
    expect(JSON.stringify(status.json())).not.toContain(connector.secret)

    const replay = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/complete',
      headers: {
        origin: 'https://chat.deepseek.com',
        'content-type': 'text/plain;charset=UTF-8',
      },
      payload: JSON.stringify({
        sessionId: connector.sessionId,
        secret: connector.secret,
        token,
      }),
    })
    expect(replay.statusCode).toBe(200)
    expect(replay.json()).toMatchObject({
      status: 'complete',
      accountId: completedBody.accountId,
    })
    expect(storeManager.getAccounts()).toHaveLength(accountCount + 1)
    expect(JSON.stringify(storeManager.listAuditLogs(50))).not.toContain(token)
    expect(JSON.stringify(storeManager.listAuditLogs(50))).not.toContain(connector.secret)
  })

  it('links through a transport-bound native connector capability', async () => {
    const accountCount = storeManager.getAccounts().length
    const started = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/sessions',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        name: 'Native-linked account',
        email: 'native-linked@example.com',
        dailyLimit: 300,
      },
    })
    const link = started.json<{
      id: string
      connectorCode: string
      nativeConnectorCode: string
    }>()
    const browserConnector = JSON.parse(
      Buffer.from(
        link.connectorCode.slice('c2a-ds-link-v1.'.length),
        'base64url',
      ).toString('utf8'),
    ) as { secret: string }
    const connector = JSON.parse(
      Buffer.from(
        link.nativeConnectorCode.slice('c2a-ds-native-v1.'.length),
        'base64url',
      ).toString('utf8'),
    ) as { endpoint: string; sessionId: string; secret: string }
    const token = 'native-session-token-that-must-remain-private'

    const browserRequest = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/native-complete',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-chat2api-connector': 'native-v1',
      },
      payload: {
        sessionId: connector.sessionId,
        secret: connector.secret,
        token,
      },
    })
    expect(browserRequest.statusCode).toBe(403)

    const wrongTransportSecret = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/native-complete',
      headers: {
        'content-type': 'application/json',
        'x-chat2api-connector': 'native-v1',
      },
      payload: {
        sessionId: connector.sessionId,
        secret: browserConnector.secret,
        token,
      },
    })
    expect(wrongTransportSecret.statusCode).toBe(401)

    const completed = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/native-complete',
      headers: {
        'content-type': 'application/json',
        'x-chat2api-connector': 'native-v1',
      },
      payload: {
        sessionId: connector.sessionId,
        secret: connector.secret,
        token,
      },
    })
    const completedBody = completed.json<{ status: string; accountId: string }>()
    expect(completed.statusCode).toBe(201)
    expect(completed.headers['access-control-allow-origin']).toBeUndefined()
    expect(completedBody.status).toBe('complete')
    expect(JSON.stringify(completedBody)).not.toContain(token)
    expect(storeManager.getAccounts()).toHaveLength(accountCount + 1)
    expect(storeManager.getAccountById(completedBody.accountId, true)?.credentials.token).toBe(token)

    const replay = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/native-complete',
      headers: {
        'content-type': 'application/json',
        'x-chat2api-connector': 'native-v1',
      },
      payload: {
        sessionId: connector.sessionId,
        secret: connector.secret,
        token,
      },
    })
    expect(replay.statusCode).toBe(200)
    expect(storeManager.getAccounts()).toHaveLength(accountCount + 1)
    expect(JSON.stringify(storeManager.listAuditLogs(50))).not.toContain(token)
    expect(JSON.stringify(storeManager.listAuditLogs(50))).not.toContain(connector.secret)
    expect(JSON.stringify(storeManager.listAuditLogs(50))).not.toContain(browserConnector.secret)
  })

  it('does not persist an invalid automatically captured DeepSeek session', async () => {
    const accountCount = storeManager.getAccounts().length
    const started = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/sessions',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { name: 'Invalid browser session' },
    })
    const link = started.json<{ id: string; connectorCode: string }>()
    const connector = JSON.parse(
      Buffer.from(
        link.connectorCode.slice('c2a-ds-link-v1.'.length),
        'base64url',
      ).toString('utf8'),
    ) as { sessionId: string; secret: string }
    const invalidToken = 'invalid-browser-token-that-must-remain-private'

    const rejected = await app.inject({
      method: 'POST',
      url: '/admin/api/deepseek-link/complete',
      headers: {
        origin: 'https://chat.deepseek.com',
        'content-type': 'text/plain;charset=UTF-8',
      },
      payload: JSON.stringify({
        sessionId: connector.sessionId,
        secret: connector.secret,
        token: invalidToken,
      }),
    })
    expect(rejected.statusCode).toBe(422)
    expect(rejected.json()).toMatchObject({
      error: {
        code: 'credential_validation_failed',
        details: { reason: 'provider_authentication_failed' },
      },
    })
    expect(storeManager.getAccounts()).toHaveLength(accountCount)
    expect(JSON.stringify(rejected.json())).not.toContain(invalidToken)

    const status = await app.inject({
      method: 'GET',
      url: `/admin/api/deepseek-link/sessions/${link.id}`,
      headers: { cookie: cookies },
    })
    expect(status.json()).toMatchObject({
      status: 'waiting',
      errorCode: 'provider_authentication_failed',
    })
    expect(JSON.stringify(status.json())).not.toContain(invalidToken)
  })

  it('rejects an invalid credential before account persistence', async () => {
    const accountCount = storeManager.getAccounts().length
    const rejected = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        providerId: 'deepseek',
        name: 'Must not persist',
        credentials: { token: 'invalid-token-that-must-remain-private' },
      },
    })

    expect(rejected.statusCode).toBe(422)
    expect(rejected.json()).toMatchObject({
      error: {
        code: 'credential_validation_failed',
      },
    })
    expect(storeManager.getAccounts()).toHaveLength(accountCount)
    expect(JSON.stringify(rejected.json())).not.toContain('invalid-token-that-must-remain-private')
    expect(JSON.stringify(storeManager.listAuditLogs(20))).not.toContain('invalid-token-that-must-remain-private')
  })
})
