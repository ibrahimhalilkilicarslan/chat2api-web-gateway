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
  backgroundAccountReserve: 0,
  backgroundUsageReserve: 0,
  accountUsageWindowMs: 15 * 60_000,
  queueMaxDepth: 10,
  queueTimeoutMs: 1000,
  deepSeekSessionTtlMs: 300_000,
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

  afterEach(() => {
    vi.restoreAllMocks()
    store.close()
  })

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

  it('does not penalize an account for invalid client media input', async () => {
    const account = addAccount('media-account')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: false, status: 400, code: 'invalid_media_input' }
      },
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)

    const result = await engine.forward(request, context)

    expect(result).toEqual({ status: 400, code: 'invalid_media_input' })
    expect(engine.getState().openCircuits).toEqual([])
    expect(store.getAccountById(account.id)?.status).toBe('active')
    expect(store.getAccountById(account.id)?.requestCount).toBe(0)
  })

  it('selects the least-used DeepSeek web account when configured', async () => {
    const busyAccount = addAccount('busy-account')
    const quietAccount = addAccount('quiet-account')
    for (let index = 0; index < 3; index += 1) {
      store.consumeAccountUsageWindow(
        busyAccount.id,
        undefined,
        runtimeConfig.accountUsageWindowMs,
        Date.now() - index,
      )
    }
    store.consumeAccountUsageWindow(
      quietAccount.id,
      undefined,
      runtimeConfig.accountUsageWindowMs,
      Date.now(),
    )
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

  it('queues a second request while the only account is busy', async () => {
    addAccount('only-account')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: true, status: 200, body: { choices: [] } }
      },
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const first = await engine.forward(request, context)
    expect(first).not.toHaveProperty('code')
    if ('code' in first) return

    const secondPromise = engine.forward(request, {
      ...context,
      requestId: randomUUID(),
    })
    await vi.waitFor(() => {
      expect(engine.getState().accountQueue[0]).toMatchObject({ foreground: 1 })
    })

    first.release(true)
    const second = await secondPromise
    expect(second).not.toHaveProperty('code')
    if ('code' in second) return
    second.release(true)
    expect(engine.getState().accountQueue).toEqual([])
  })

  it('prioritizes foreground drafts over queued background work', async () => {
    addAccount('only-account')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: true, status: 200, body: { choices: [] } }
      },
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)
    const first = await engine.forward(request, context)
    expect(first).not.toHaveProperty('code')
    if ('code' in first) return

    const order: string[] = []
    const backgroundPromise = engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'background',
    }).then((result) => {
      order.push('background')
      return result
    })
    const foregroundPromise = engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'foreground',
    }).then((result) => {
      order.push('foreground')
      return result
    })

    await vi.waitFor(() => {
      expect(engine.getState().accountQueue[0]).toMatchObject({
        foreground: 1,
        background: 1,
      })
    })
    first.release(true)

    const foreground = await foregroundPromise
    expect(order).toEqual(['foreground'])
    if ('code' in foreground) return
    foreground.release(true)
    const background = await backgroundPromise
    expect(order).toEqual(['foreground', 'background'])
    if (!('code' in background)) background.release(true)
  })

  it('keeps one idle account reserved while background work is running', async () => {
    addAccount('background-account')
    addAccount('foreground-reserve')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: true, status: 200, body: { choices: [] } }
      },
    }
    const engine = new ProviderRoutingEngine(
      { ...runtimeConfig, backgroundAccountReserve: 1 },
      runtime,
      store,
    )

    const background = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'background',
    })
    expect(background).not.toHaveProperty('code')
    if ('code' in background) return

    const secondBackground = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'background',
    })
    expect(secondBackground).toEqual({
      status: 503,
      code: 'background_capacity_reserved',
      retryAfterSeconds: 30,
    })

    const foreground = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'foreground',
    })
    expect(foreground).not.toHaveProperty('code')
    if (!('code' in foreground)) {
      expect(foreground.selection.account.id).not.toBe(background.selection.account.id)
      foreground.release(true)
    }
    background.release(true)
  })

  it('pauses background work when only the foreground reserve remains', async () => {
    addAccount('foreground-only')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: true, status: 200, body: { choices: [] } }
      },
    }
    const engine = new ProviderRoutingEngine(
      { ...runtimeConfig, backgroundAccountReserve: 1 },
      runtime,
      store,
    )

    expect(await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'background',
    })).toEqual({
      status: 503,
      code: 'background_capacity_reserved',
      retryAfterSeconds: 30,
    })

    const foreground = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'foreground',
    })
    expect(foreground).not.toHaveProperty('code')
    if (!('code' in foreground)) foreground.release(true)
  })

  it('preserves rolling account capacity for foreground requests', async () => {
    const account = addAccount('window-reserve')
    store.updateAccount(account.id, { dailyLimit: 50 })
    for (let index = 0; index < 40; index += 1) {
      store.consumeAccountUsageWindow(
        account.id,
        50,
        runtimeConfig.accountUsageWindowMs,
        Date.now() - index,
      )
    }
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: true, status: 200, body: { choices: [] } }
      },
    }
    const engine = new ProviderRoutingEngine(
      {
        ...runtimeConfig,
        backgroundAccountReserve: 0,
        backgroundUsageReserve: 10,
      },
      runtime,
      store,
    )

    expect(await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'background',
    })).toEqual({
      status: 503,
      code: 'background_usage_capacity_reserved',
      retryAfterSeconds: expect.any(Number),
    })

    const foreground = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
      priority: 'foreground',
    })
    expect(foreground).not.toHaveProperty('code')
    if (!('code' in foreground)) foreground.release(true)
  })

  it('restores routing capacity as attempts expire from the usage window', async () => {
    const now = 2_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const account = addAccount('rolling-window')
    store.updateAccount(account.id, { dailyLimit: 2 })
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: true, status: 200, body: { choices: [] } }
      },
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)

    for (let index = 0; index < 2; index += 1) {
      const result = await engine.forward(request, {
        ...context,
        requestId: randomUUID(),
      })
      expect(result).not.toHaveProperty('code')
      if (!('code' in result)) result.release(true)
    }

    const exhausted = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
    })
    expect(exhausted).toMatchObject({
      status: 429,
      code: 'account_usage_window_exhausted',
      retryAfterSeconds: 15 * 60,
    })

    vi.mocked(Date.now).mockReturnValue(now + runtimeConfig.accountUsageWindowMs + 1)
    const recovered = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
    })
    expect(recovered).not.toHaveProperty('code')
    if (!('code' in recovered)) recovered.release(true)
    expect(store.getAccountUsageWindow(
      account.id,
      runtimeConfig.accountUsageWindowMs,
      Date.now(),
    ).used).toBe(1)
  })

  it('counts failed provider attempts against the rolling safety budget', async () => {
    const account = addAccount('failed-attempt')
    store.updateAccount(account.id, { dailyLimit: 1 })
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: false, status: 502, code: 'provider_unavailable' }
      },
    }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)

    expect(await engine.forward(request, context)).toMatchObject({
      status: 502,
      code: 'provider_unavailable',
    })
    expect(await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
    })).toMatchObject({
      status: 429,
      code: 'account_usage_window_exhausted',
    })
    expect(store.getAccountUsageWindow(
      account.id,
      runtimeConfig.accountUsageWindowMs,
    ).used).toBe(1)
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
    expect(engine.getState().openCircuits[0]?.code).toBe('provider_rate_limited')

    const retry = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
    })
    expect(retry).toMatchObject({
      status: 429,
      code: 'provider_rate_limited',
    })
    if (!('code' in retry)) return
    expect(retry.retryAfterSeconds).toBeGreaterThanOrEqual(20)
  })

  it('temporarily cools down an account when Expert capacity is busy', async () => {
    const account = addAccount('only-account')
    const forwardChatCompletion = vi.fn<ProviderRuntimeAdapter['forwardChatCompletion']>(
      async () => ({
        success: false,
        status: 503,
        code: 'provider_expert_busy',
        retryAfterMs: 30_000,
      }),
    )
    const runtime: ProviderRuntimeAdapter = { forwardChatCompletion }
    const engine = new ProviderRoutingEngine(runtimeConfig, runtime, store)

    const result = await engine.forward(request, context)
    expect(result).toMatchObject({
      status: 503,
      code: 'provider_expert_busy',
    })
    if (!('code' in result)) return
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(30)
    expect(result.retryAfterSeconds).toBeLessThanOrEqual(33)

    expect(forwardChatCompletion).toHaveBeenCalledTimes(1)
    expect(engine.getState().openCircuits[0]).toMatchObject({ accountId: account.id })
    const retry = await engine.forward(request, {
      ...context,
      requestId: randomUUID(),
    })
    expect(retry).toMatchObject({ status: 503, code: 'provider_expert_busy' })
    if (!('code' in retry)) return
    expect(retry.retryAfterSeconds).toBeGreaterThanOrEqual(30)
    expect(retry.retryAfterSeconds).toBeLessThanOrEqual(33)
    expect(store.getAccountById(account.id)?.status).toBe('active')
  })

  it('fails over to one healthy alternative when Expert capacity is busy', async () => {
    const first = addAccount('first')
    const second = addAccount('second')
    const forwardChatCompletion = vi.fn<ProviderRuntimeAdapter['forwardChatCompletion']>(
      async (_request, selection) => selection.account.id === first.id
        ? {
            success: false,
            status: 503,
            code: 'provider_expert_busy',
            retryAfterMs: 30_000,
          }
        : { success: true, status: 200, body: { choices: [] } },
    )
    const engine = new ProviderRoutingEngine(
      runtimeConfig,
      { forwardChatCompletion },
      store,
    )

    const result = await engine.forward(request, context)

    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    expect(result.attempts).toBe(2)
    expect(result.selection.account.id).toBe(second.id)
    expect(forwardChatCompletion).toHaveBeenCalledTimes(2)
    expect(engine.getState().openCircuits).toEqual([
      expect.objectContaining({ accountId: first.id }),
    ])
    result.release(true)
  })

  it('limits Expert busy failover to one alternative account', async () => {
    addAccount('first')
    addAccount('second')
    addAccount('third')
    const forwardChatCompletion = vi.fn<ProviderRuntimeAdapter['forwardChatCompletion']>(
      async () => ({
        success: false,
        status: 503,
        code: 'provider_expert_busy',
        retryAfterMs: 30_000,
      }),
    )
    const engine = new ProviderRoutingEngine(
      runtimeConfig,
      { forwardChatCompletion },
      store,
    )

    const result = await engine.forward(request, context)

    expect(result).toMatchObject({ status: 503, code: 'provider_expert_busy' })
    expect(forwardChatCompletion).toHaveBeenCalledTimes(2)
    expect(engine.getState().openCircuits).toHaveLength(2)
  })

  it('routes only one record when multiple entries resolve to the same provider identity', async () => {
    const first = addAccount('first')
    addAccount('duplicate')
    const forwardChatCompletion = vi.fn<ProviderRuntimeAdapter['forwardChatCompletion']>(
      async (_request, selection) => ({
        success: true,
        status: 200,
        body: { accountId: selection.account.id },
      }),
    )
    const engine = new ProviderRoutingEngine(
      runtimeConfig,
      { forwardChatCompletion },
      store,
      { getAccountIdentityFingerprint: () => 'same-provider-identity' },
    )

    const result = await engine.forward(request, context)
    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    expect(result.selection.account.id).toBe(first.id)
    expect(forwardChatCompletion).toHaveBeenCalledTimes(1)
    result.release(true)
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
    const onAccountSuspended = vi.fn()
    const engine = new ProviderRoutingEngine(
      runtimeConfig,
      runtime,
      store,
      { onAccountSuspended },
    )
    const result = await engine.forward(request, context)

    expect(result).toMatchObject({
      status: 503,
      code: 'provider_account_suspended',
    })
    if (!('code' in result)) return
    expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(59)
    expect(store.getAccountById(first.id)?.status).toBe('error')
    expect(store.getAccountById(second.id)?.status).toBe('error')
    expect(store.getAccountById(first.id)?.errorMessage).toContain('temporarily suspended')
    expect(onAccountSuspended).toHaveBeenCalledTimes(2)
  })

  it('records a provider suspension discovered after streaming has started', async () => {
    const account = addAccount('streaming-account')
    const runtime: ProviderRuntimeAdapter = {
      async forwardChatCompletion() {
        return { success: true, status: 200, body: { choices: [] } }
      },
    }
    const onAccountSuspended = vi.fn()
    const engine = new ProviderRoutingEngine(
      runtimeConfig,
      runtime,
      store,
      { onAccountSuspended },
    )
    const result = await engine.forward(request, context)

    expect(result).not.toHaveProperty('code')
    if ('code' in result) return
    result.release(false, {
      success: false,
      status: 403,
      code: 'provider_account_suspended',
      retryAfterMs: 60_000,
    })

    expect(store.getAccountById(account.id)).toMatchObject({
      status: 'error',
      requestCount: 0,
      todayUsed: 0,
    })
    expect(engine.getState().openCircuits[0]).toMatchObject({ accountId: account.id })
    expect(onAccountSuspended).toHaveBeenCalledTimes(1)
  })
})
