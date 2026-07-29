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

  it('seeds providers disabled and masks credentials by default', () => {
    expect(store.getProviders()).not.toHaveLength(0)
    expect(store.getProviders().every((provider) => !provider.enabled)).toBe(true)

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

  it('merges partial credential rotation without dropping existing fields', () => {
    const accountId = randomUUID()
    store.addAccount({
      id: accountId,
      providerId: 'mimo',
      name: 'MiMo account',
      credentials: {
        service_token: 'service-secret',
        user_id: 'user-1',
        ph_token: 'old-ph-secret',
      },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    store.updateAccount(accountId, {
      credentials: { ph_token: 'new-ph-secret' },
    })

    expect(store.getAccountById(accountId, true)?.credentials).toEqual({
      service_token: 'service-secret',
      user_id: 'user-1',
      ph_token: 'new-ph-secret',
    })
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
      requestLogConfig: {
        enabled: true,
        maxEntries: 2,
        includeBodies: false,
      },
    })

    for (let index = 0; index < 3; index += 1) {
      store.startRequestLog({
        requestId: randomUUID(),
        method: 'POST',
        url: '/v1/chat/completions',
        model: `model-${index}`,
        isStream: false,
      })
    }

    const persisted = store.listRequestLogs(10)
    expect(persisted).toHaveLength(2)
    expect(persisted.map((entry) => entry.model)).toEqual(['model-2', 'model-1'])
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
