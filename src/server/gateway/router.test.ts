import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeConfig } from '../../core/config.js'
import { StoreManager } from '../../main/store/store.js'
import type { Account } from '../../main/store/types.js'
import type { ChatCompletionRequest, ProxyContext } from '../../main/proxy/types.js'
import {
  ProviderRoutingEngine,
  type ProviderRuntimeAdapter,
} from './router.js'

const runtimeConfig: RuntimeConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 8080,
  databasePath: ':memory:',
  logLevel: 'error',
  trustProxy: false,
  secureCookies: false,
  masterKey: Buffer.alloc(32, 1),
  bootstrapApiKey: 'bootstrap-key-that-is-at-least-thirty-two-characters',
  adminToken: 'admin-token-that-is-at-least-thirty-two-characters',
  sessionSecret: 'session-secret-that-is-at-least-thirty-two-characters',
  adminOrigins: ['http://localhost:8080'],
  maxBodyBytes: 2 * 1024 * 1024,
  globalConcurrency: 10,
  accountConcurrency: 1,
  rateLimitRpm: 60,
  dailyQuota: 100,
  requestTimeoutMs: 10_000,
  firstByteTimeoutMs: 1_000,
}

const request: ChatCompletionRequest = {
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: 'hello' }],
  stream: false,
}

const context: ProxyContext = {
  requestId: randomUUID(),
  model: request.model,
  startTime: Date.now(),
  isStream: false,
}

describe('provider routing engine', () => {
  let store: StoreManager

  beforeEach(() => {
    store = new StoreManager()
    store.initialize({ databasePath: ':memory:', masterKey: Buffer.alloc(32, 9) })
    store.updateProvider('deepseek', { enabled: true })
  })

  afterEach(() => store.close())

  function addAccount(name: string, providerId = 'deepseek'): Account {
    const account: Account = {
      id: randomUUID(),
      providerId,
      name,
      credentials: providerId === 'deepseek-api'
        ? { apiKey: `${name}-secret` }
        : { token: `${name}-secret` },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      requestCount: 0,
      todayUsed: 0,
    }
    store.addAccount(account)
    return account
  }

  it('routes a request and updates operational usage after release', async () => {
    const account = addAccount('primary')
    const forwardChatCompletion = vi.fn<ProviderRuntimeAdapter['forwardChatCompletion']>(
      async () => ({
        success: true,
        status: 200,
        body: { choices: [{ message: { content: 'ok' } }] },
      }),
    )
    const runtime: ProviderRuntimeAdapter = {
      forwardChatCompletion,
      createTransformStream: () => new PassThrough(),
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    expect(result.selection.account.id).toBe(account.id)
    expect(result.selection.actualModel).toBe('deepseek-v4-flash')
    result.release(true)
    result.release(true)
    expect(store.getAccountById(account.id)?.requestCount).toBe(1)
    expect(engine.getState().accountConcurrency).toEqual([])
  })

  it('fails over once on an upstream 5xx response', async () => {
    addAccount('first')
    addAccount('second')
    let attempts = 0
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        attempts += 1
        if (attempts === 1) return { success: false, status: 502 }
        return { success: true, status: 200, body: { choices: [] } }
      },
      createTransformStream: () => new PassThrough(),
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    expect(result.attempts).toBe(2)
    result.release(true)
  })

  it('does not fail over after a client-side provider rejection', async () => {
    addAccount('first')
    addAccount('second')
    const forwardChatCompletion = vi.fn<ProviderRuntimeAdapter['forwardChatCompletion']>(
      async () => ({ success: false, status: 400 }),
    )
    const runtime: ProviderRuntimeAdapter = {
      forwardChatCompletion,
      createTransformStream: () => new PassThrough(),
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).toEqual({ status: 502, code: 'upstream_unavailable' })
    expect(forwardChatCompletion).toHaveBeenCalledTimes(1)
  })

  it('prefers the official API and falls back to the web session on throttling', async () => {
    store.updateProvider('deepseek-api', { enabled: true })
    const web = addAccount('web-fallback')
    const official = addAccount('official-primary', 'deepseek-api')
    const attemptedProviders: string[] = []
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion(_request, selection) {
        attemptedProviders.push(selection.provider.id)
        if (selection.account.id === official.id) {
          return { success: false, status: 429, retryAfterMs: 30_000 }
        }
        return { success: true, status: 200, body: { choices: [] } }
      },
      createTransformStream: () => new PassThrough(),
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    expect(attemptedProviders).toEqual(['deepseek-api', 'deepseek'])
    expect(result.selection.account.id).toBe(web.id)
    result.release(true)
  })

  it('keeps web-search requests on providers that explicitly support web search', async () => {
    store.updateProvider('deepseek-api', { enabled: true })
    const web = addAccount('web-search')
    addAccount('official', 'deepseek-api')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion(_request, selection) {
        return { success: true, status: 200, body: { provider: selection.provider.id } }
      },
      createTransformStream: () => new PassThrough(),
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward({ ...request, web_search: true }, context)

    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    expect(result.selection.account.id).toBe(web.id)
    expect(result.selection.provider.id).toBe('deepseek')
    result.release(true)
  })

  it('returns a retry hint when every matching account is rate limited', async () => {
    const account = addAccount('only-account')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: false, status: 429, retryAfterMs: 20_000 }
      },
      createTransformStream: () => new PassThrough(),
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).toMatchObject({
      status: 429,
      code: 'provider_rate_limited',
    })
    if (!('code' in result)) return
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(20)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(22)
    expect(engine.getState().openCircuits[0]?.accountId).toBe(account.id)
  })
})
