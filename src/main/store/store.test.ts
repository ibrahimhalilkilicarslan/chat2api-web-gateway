import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StoreManager } from './store.js'

describe('encrypted gateway store', () => {
  let store: StoreManager

  beforeEach(() => {
    store = new StoreManager()
    store.initialize({
      databasePath: ':memory:',
      masterKey: Buffer.alloc(32, 11),
    })
  })

  afterEach(() => store.close())

  it('exposes only the enabled DeepSeek web provider and masks credentials by default', () => {
    expect(store.getProviders()).toHaveLength(1)
    expect(store.getProviders()[0]).toMatchObject({
      id: 'deepseek',
      enabled: true,
      authType: 'userToken',
    })
    expect(store.getProviderById('deepseek-api')).toBeUndefined()

    const accountId = randomUUID()
    store.addAccount({
      id: accountId,
      providerId: 'deepseek',
      name: 'Primary account',
      credentials: { token: 'first-secret' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    expect(store.getAccountById(accountId)?.credentials).toEqual({})
    expect(store.getAccountById(accountId, true)?.credentials).toEqual({
      token: 'first-secret',
    })
  })

  it('rotates the DeepSeek web credential without exposing it', () => {
    const accountId = randomUUID()
    store.addAccount({
      id: accountId,
      providerId: 'deepseek',
      name: 'DeepSeek account',
      credentials: { token: 'old-token' },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    store.updateAccount(accountId, {
      credentials: { token: 'new-token' },
    })

    expect(store.getAccountById(accountId)?.credentials).toEqual({})
    expect(store.getAccountById(accountId, true)?.credentials).toEqual({ token: 'new-token' })
  })

  it('stores API keys as hashes and enforces daily quota atomically', () => {
    const created = store.createApiKey({
      name: 'Test client',
      scopes: ['chat'],
      requestsPerMinute: 10,
      dailyQuota: 2,
    })

    const matched = store.findApiKey(created.rawKey)
    expect(matched).toBeDefined()
    expect(matched?.keyHash).not.toContain(created.rawKey)
    expect(store.getApiKeys()[0]).not.toHaveProperty('keyHash')
    expect(store.consumeApiKeyDailyQuota(matched!).allowed).toBe(true)
    expect(store.consumeApiKeyDailyQuota(matched!).allowed).toBe(true)
    expect(store.consumeApiKeyDailyQuota(matched!).allowed).toBe(false)
  })

  it('rotates the environment-managed bootstrap key and preserves admin keys', () => {
    const firstKey = 'first-bootstrap-key-that-is-at-least-thirty-two-characters'
    const secondKey = 'second-bootstrap-key-that-is-at-least-thirty-two-characters'
    store.seedBootstrapApiKey(firstKey, 10, 20)
    const adminKey = store.createApiKey({
      name: 'Admin-created client',
      scopes: ['models'],
      requestsPerMinute: 5,
      dailyQuota: 10,
    })

    expect(store.findApiKey(firstKey)).toBeDefined()
    store.seedBootstrapApiKey(secondKey, 30, 40)

    expect(store.findApiKey(firstKey)).toBeUndefined()
    expect(store.findApiKey(secondKey)).toMatchObject({
      managedByEnvironment: true,
      requestsPerMinute: 30,
      dailyQuota: 40,
    })
    expect(store.findApiKey(adminKey.rawKey)).toBeDefined()
    const bootstrap = store.getApiKeys().find((record) => record.managedByEnvironment)
    expect(bootstrap).toBeDefined()
    expect(store.setApiKeyEnabled(bootstrap!.id, false)).toBe(false)
    expect(store.deleteApiKey(bootstrap!.id)).toBe(false)
  })

  it('enforces API key expiry, CIDR policy persistence and grace rotation', () => {
    const created = store.createApiKey({
      name: 'Restricted client',
      scopes: ['chat', 'models'],
      requestsPerMinute: 12,
      dailyQuota: 120,
      allowedCidrs: ['203.0.113.0/24'],
      expiresAt: Date.now() + 60 * 60_000,
    })

    expect(store.findApiKey(created.rawKey)).toMatchObject({
      allowedCidrs: ['203.0.113.0/24'],
      expiresAt: expect.any(Number),
    })

    const rotated = store.rotateApiKey(created.record.id, 0, Date.now() + 2 * 60 * 60_000)
    expect(rotated?.rawKey).toMatch(/^c2a_/)
    expect(store.findApiKey(created.rawKey)).toBeUndefined()
    expect(store.findApiKey(rotated!.rawKey)).toMatchObject({
      rotatedFromId: created.record.id,
      allowedCidrs: ['203.0.113.0/24'],
      requestsPerMinute: 12,
    })
    expect(store.getApiKeyById(created.record.id)?.replacedById).toBe(rotated?.record.id)
  })

  it('computes operational percentiles without storing request bodies', () => {
    for (const [index, latency] of [10, 20, 30, 40, 100].entries()) {
      const log = store.startRequestLog({
        requestId: randomUUID(),
        method: 'POST',
        url: '/v1/chat/completions',
        model: 'deepseek-v4-flash',
        accountId: 'account-a',
        isStream: index % 2 === 0,
      })
      store.finishRequestLog(log.id, {
        status: index === 4 ? 'error' : 'success',
        statusCode: index === 4 ? 502 : 200,
        latency,
        errorCode: index === 4 ? 'provider_unavailable' : undefined,
      })
    }

    expect(store.getOperationalMetrics()).toMatchObject({
      sampleSize: 5,
      latency: {
        average: 40,
        p50: 30,
        p95: 100,
        maximum: 100,
      },
      status: {
        success: 4,
        error: 1,
        pending: 0,
      },
      errorsByCode: [{ code: 'provider_unavailable', count: 1 }],
      usageByAccount: [{ accountId: 'account-a', count: 5 }],
    })
    expect(store.getMaintenanceStatus()).toMatchObject({
      integrity: 'ok',
      schemaVersion: 2,
    })
  })

  it('persists request metadata without prompt or response bodies', () => {
    const log = store.startRequestLog({
      requestId: randomUUID(),
      method: 'POST',
      url: '/v1/chat/completions',
      model: 'model-a',
      isStream: false,
    })
    store.finishRequestLog(log.id, {
      status: 'success',
      statusCode: 200,
      latency: 15,
    })

    const persisted = store.listRequestLogs(1)[0]
    expect(persisted).toMatchObject({
      method: 'POST',
      model: 'model-a',
      status: 'success',
    })
    expect(persisted).not.toHaveProperty('requestBody')
    expect(persisted).not.toHaveProperty('responseBody')
    expect(persisted).not.toHaveProperty('userInput')
  })

  it('prunes request metadata to the configured retention limit', () => {
    store.updateConfig({
      requestLogMaxEntries: 10,
    })

    for (let index = 0; index < 11; index += 1) {
      store.startRequestLog({
        requestId: randomUUID(),
        method: 'POST',
        url: '/v1/chat/completions',
        model: `model-${index}`,
        isStream: false,
      })
    }

    const persisted = store.listRequestLogs(10)
    expect(persisted).toHaveLength(10)
    expect(persisted.map((entry) => entry.model)).toEqual([
      'model-10',
      'model-9',
      'model-8',
      'model-7',
      'model-6',
      'model-5',
      'model-4',
      'model-3',
      'model-2',
      'model-1',
    ])
  })

  it('fails closed when the persistent credential vault key is wrong', () => {
    const directory = mkdtempSync(join(tmpdir(), 'chat2api-store-'))
    const databasePath = join(directory, 'gateway.sqlite')
    const persistent = new StoreManager()

    try {
      persistent.initialize({
        databasePath,
        masterKey: Buffer.alloc(32, 21),
      })
      persistent.addAccount({
        id: randomUUID(),
        providerId: 'deepseek',
        name: 'Persistent account',
        credentials: { token: 'encrypted-provider-token' },
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      persistent.close()

      const wrongKeyStore = new StoreManager()
      expect(() => wrongKeyStore.initialize({
        databasePath,
        masterKey: Buffer.alloc(32, 22),
      })).toThrow('cannot be decrypted')
      expect(() => wrongKeyStore.assertReady()).toThrow('cannot be decrypted')
    } finally {
      persistent.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
