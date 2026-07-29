import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type { RuntimeConfig } from '../core/config.js'
import { storeManager } from '../main/store/store.js'
import { buildApp } from './app.js'
import type { AccountHealthChecker } from './providers/account-health.js'

const origin = 'http://gateway.test'
const bootstrapApiKey = 'bootstrap-api-key-that-is-at-least-thirty-two-characters'
const adminToken = 'admin-token-that-is-at-least-thirty-two-characters'
const accountHealthChecker: AccountHealthChecker = async () => ({
  healthy: true,
  status: 'healthy',
  code: 'provider_healthy',
  message: 'Test provider credential is valid.',
  checkedAt: Date.now(),
  latencyMs: 4,
})

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
  maxBodyBytes: 2 * 1024 * 1024,
  globalConcurrency: 5,
  accountConcurrency: 1,
  rateLimitRpm: 20,
  dailyQuota: 100,
  requestTimeoutMs: 10_000,
  firstByteTimeoutMs: 1_000,
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

  it('enforces CSRF and never returns provider credentials', async () => {
    const missingCsrf = await app.inject({
      method: 'PATCH',
      url: '/admin/api/providers/deepseek',
      headers: { origin, cookie: cookies },
      payload: { enabled: true },
    })
    expect(missingCsrf.statusCode).toBe(403)

    const enabled = await app.inject({
      method: 'PATCH',
      url: '/admin/api/providers/deepseek',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: { enabled: true },
    })
    expect(enabled.statusCode).toBe(200)

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

  it('tests provider credentials without returning or auditing the secret', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/api/accounts',
      headers: { origin, cookie: cookies, 'x-csrf-token': csrfToken },
      payload: {
        providerId: 'deepseek-api',
        name: 'Official API health account',
        credentials: { apiKey: 'official-provider-key-that-must-remain-private' },
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
    expect(serialized).not.toContain('official-provider-key-that-must-remain-private')
    const auditLogs = storeManager.listAuditLogs(20)
    expect(auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'account.health_check',
        outcome: 'success',
        metadata: {
          providerId: 'deepseek-api',
          healthCode: 'provider_healthy',
        },
      }),
    ]))
    expect(JSON.stringify(auditLogs)).not.toContain('official-provider-key-that-must-remain-private')
  })
})
