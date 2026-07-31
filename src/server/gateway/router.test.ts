import { randomUUID } from 'node:crypto'
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
  adminHosts: [],
  maxBodyBytes: 2 * 1024 * 1024,
  globalConcurrency: 10,
  accountConcurrency: 1,
  rateLimitRpm: 60,
  dailyQuota: 100,
  requestTimeoutMs: 10_000,
  firstByteTimeoutMs: 1_000,
  streamIdleTimeoutMs: 1_000,
  accountHealthIntervalMs: 0,
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

  function addAccount(name: string, todayUsed = 0): Account {
    const account: Account = {
      id: randomUUID(),
      providerId: 'deepseek',
      name,
      credentials: { token: `${name}-secret` },
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      requestCount: 0,
      todayUsed,
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
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).toEqual({ status: 502, code: 'provider_rejected_request' })
    expect(forwardChatCompletion).toHaveBeenCalledTimes(1)
  })

  it('selects the least-used DeepSeek web account when configured', async () => {
    const busyAccount = addAccount('busy-account', 50)
    const quietAccount = addAccount('quiet-account', 2)
    store.updateConfig({ loadBalanceStrategy: 'least-used' })
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion(_request, selection) {
        return { success: true, status: 200, body: { accountId: selection.account.id } }
      },
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    expect(result.selection.account.id).toBe(quietAccount.id)
    expect(result.selection.account.id).not.toBe(busyAccount.id)
    result.release(true)
  })

  it('keeps web-search requests on the DeepSeek web provider', async () => {
    const web = addAccount('web-search')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion(_request, selection) {
        return { success: true, status: 200, body: { provider: selection.provider.id } }
      },
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

  it('removes suspended provider accounts from routing and returns a retry hint', async () => {
    const first = addAccount('first')
    const second = addAccount('second')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return {
          success: false,
          status: 403,
          code: 'provider_account_suspended',
          retryAfterMs: 60_000,
        }
      },
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const result = await engine.forward(request, context)

    expect(result).toMatchObject({
      status: 503,
      code: 'provider_account_suspended',
    })
    if (!('code' in result)) return
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(59)
    expect(store.getAccountById(first.id)?.status).toBe('error')
    expect(store.getAccountById(second.id)?.status).toBe('error')
  })
})
