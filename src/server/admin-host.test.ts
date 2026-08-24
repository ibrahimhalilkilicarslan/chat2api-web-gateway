import type { RuntimeConfig } from '../core/config.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app.js'

const config: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 8080,
  databasePath: ':memory:',
  logLevel: 'fatal',
  trustProxy: false,
  secureCookies: false,
  masterKey: Buffer.alloc(32, 23),
  bootstrapApiKey: 'bootstrap-api-key-that-is-at-least-thirty-two-characters',
  adminToken: 'admin-token-that-is-at-least-thirty-two-characters',
  sessionSecret: 'session-secret-that-is-at-least-thirty-two-characters',
  adminOrigins: ['https://admin.gateway.test'],
  adminHosts: ['admin.gateway.test'],
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

describe('admin hostname boundary', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp(config)
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('hides admin routes on unlisted hostnames without affecting the API', async () => {
    const hidden = await app.inject({
      method: 'GET',
      url: '/admin/api/session',
      headers: { host: 'api.gateway.test' },
    })
    const protectedAdmin = await app.inject({
      method: 'GET',
      url: '/admin/api/session',
      headers: { host: 'admin.gateway.test' },
    })
    const publicApi = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { host: 'api.gateway.test' },
    })

    expect(hidden.statusCode).toBe(404)
    expect(protectedAdmin.statusCode).toBe(401)
    expect(publicApi.statusCode).toBe(401)
  })
})
