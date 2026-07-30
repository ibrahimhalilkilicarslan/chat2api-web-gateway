import type { Readable } from 'node:stream'
import type { RuntimeConfig } from '../../core/config.js'
import { requestForwarder } from '../../main/proxy/forwarder.js'
import type {
  AccountSelection,
  ChatCompletionRequest,
  ForwardResult,
  ProxyContext,
} from '../../main/proxy/types.js'
import { storeManager } from '../../main/store/store.js'
import { enforceIdleTimeout, primeStream, type PrimedStream } from './streaming.js'

interface CircuitState {
  failures: number
  openedUntil: number
}

export interface RoutedResult {
  result: ForwardResult
  selection: AccountSelection
  primed?: PrimedStream
  release: (success: boolean) => void
  attempts: number
}

export interface RoutingFailure {
  status: number
  code: string
  retryAfterSeconds?: number
}

export interface ProviderRuntimeAdapter {
  forwardChatCompletion: (
    request: ChatCompletionRequest,
    selection: AccountSelection,
    context: ProxyContext,
  ) => Promise<ForwardResult>
}

const defaultProviderRuntime: ProviderRuntimeAdapter = {
  forwardChatCompletion(request, selection, context) {
    return requestForwarder.forwardChatCompletion(
      request,
      selection.account,
      selection.provider,
      selection.actualModel,
      context,
    )
  },
}

export class ProviderRoutingEngine {
  private readonly activeByAccount = new Map<string, number>()
  private readonly circuits = new Map<string, CircuitState>()
  private roundRobinCursor = 0

  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    private readonly providerRuntime: ProviderRuntimeAdapter = defaultProviderRuntime,
    private readonly store: typeof storeManager = storeManager,
  ) {}

  async forward(
    request: ChatCompletionRequest,
    context: ProxyContext,
  ): Promise<RoutedResult | RoutingFailure> {
    const candidates = this.orderCandidates(this.getCandidates(request))
    if (candidates.length === 0) {
      return { status: 503, code: 'no_available_account' }
    }

    let attempts = 0
    let lastStatus = 502
    let lastCode = 'provider_unavailable'
    let rateLimitRetryAt: number | undefined

    for (const selection of candidates) {
      if (!this.tryReserve(selection.account.id)) continue
      attempts += 1
      const result = await this.providerRuntime.forwardChatCompletion(
        request,
        selection,
        {
          ...context,
          providerId: selection.provider.id,
          accountId: selection.account.id,
          actualModel: selection.actualModel,
        },
      )

      if (!result.success) {
        this.releaseAccount(selection.account.id)
        lastStatus = result.status ?? 502
        lastCode = result.code ?? statusCode(lastStatus)
        const circuit = this.recordFailure(
          selection.account.id,
          lastStatus,
          result.retryAfterMs,
        )
        if (lastStatus === 429 && circuit.openedUntil > 0) {
          rateLimitRetryAt = rateLimitRetryAt === undefined
            ? circuit.openedUntil
            : Math.min(rateLimitRetryAt, circuit.openedUntil)
        }
        if (lastStatus === 401 || lastStatus === 403) {
          this.store.updateAccount(selection.account.id, {
            status: 'error',
            errorMessage: 'Provider authentication requires attention.',
          })
        }
        if (!canFailOver(lastStatus)) break
        continue
      }

      let primed: PrimedStream | undefined
      if (request.stream) {
        if (!result.stream) {
          this.releaseAccount(selection.account.id)
          this.recordFailure(selection.account.id, 502)
          lastCode = 'provider_protocol_changed'
          continue
        }

        try {
          primed = await primeStream(
            result.stream,
            this.runtimeConfig.firstByteTimeoutMs,
          )
          enforceIdleTimeout(
            primed.stream,
            this.runtimeConfig.streamIdleTimeoutMs,
          )
        } catch {
          ;(result.stream as Readable).destroy()
          this.releaseAccount(selection.account.id)
          this.recordFailure(selection.account.id, 504)
          lastStatus = 504
          lastCode = 'provider_timeout'
          continue
        }
      }

      let released = false
      return {
        result,
        selection,
        primed,
        attempts,
        release: (success) => {
          if (released) return
          released = true
          this.releaseAccount(selection.account.id)
          if (success) {
            this.recordSuccess(selection.account.id)
            this.store.updateAccount(selection.account.id, {
              lastUsed: Date.now(),
              requestCount: (selection.account.requestCount ?? 0) + 1,
              todayUsed: (selection.account.todayUsed ?? 0) + 1,
              status: 'active',
              errorMessage: undefined,
            })
          } else {
            this.recordFailure(selection.account.id, 502)
          }
        },
      }
    }

    const retryAfterSeconds = lastStatus === 429
      ? Math.max(1, Math.ceil(((rateLimitRetryAt ?? Date.now() + 60_000) - Date.now()) / 1000))
      : undefined
    return {
      status: lastStatus === 429 ? 429 : lastStatus === 504 ? 504 : 502,
      code: lastCode,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    }
  }

  getState(): {
    accountConcurrency: Array<{ accountId: string; active: number }>
    openCircuits: Array<{ accountId: string; failures: number; openedUntil: number }>
  } {
    const now = Date.now()
    return {
      accountConcurrency: [...this.activeByAccount.entries()]
        .map(([accountId, active]) => ({ accountId, active })),
      openCircuits: [...this.circuits.entries()]
        .filter(([, state]) => state.openedUntil > now)
        .map(([accountId, state]) => ({
          accountId,
          failures: state.failures,
          openedUntil: state.openedUntil,
        })),
    }
  }

  private getCandidates(request: ChatCompletionRequest): AccountSelection[] {
    const provider = this.store.getProviderById('deepseek')
    if (!provider?.enabled || !this.providerSupportsModel(provider, request.model)) return []

    const now = Date.now()
    return this.store.getAccountsByProviderId('deepseek', true)
      .filter((account) => account.status === 'active')
      .filter((account) => !account.dailyLimit || (account.todayUsed ?? 0) < account.dailyLimit)
      .filter((account) => (this.activeByAccount.get(account.id) ?? 0) < this.runtimeConfig.accountConcurrency)
      .filter((account) => (this.circuits.get(account.id)?.openedUntil ?? 0) <= now)
      .map((account) => ({
        provider,
        account,
        actualModel: this.mapModel(request.model, provider),
      }))
  }

  private providerSupportsModel(
    provider: AccountSelection['provider'],
    model: string,
  ): boolean {
    const effective = this.store.getEffectiveModels(provider.id)
    const normalized = model.toLowerCase()
    return effective.some((candidate) => candidate.displayName.toLowerCase() === normalized)
  }

  private mapModel(
    model: string,
    provider: AccountSelection['provider'],
  ): string {
    const effective = this.store.getEffectiveModels(provider.id)
    const direct = effective.find(
      (candidate) => candidate.displayName.toLowerCase() === model.toLowerCase(),
    )
    return direct?.actualModelId ?? model
  }

  private orderCandidates(
    candidates: AccountSelection[],
  ): AccountSelection[] {
    const config = this.store.getConfig()
    const sorted = [...candidates].sort((left, right) => {
      if (config.loadBalanceStrategy === 'least-used') {
        return (left.account.todayUsed ?? 0) - (right.account.todayUsed ?? 0)
      }
      return left.account.createdAt - right.account.createdAt
    })

    if (config.loadBalanceStrategy !== 'round-robin' || sorted.length <= 1) {
      return sorted
    }
    const offset = this.roundRobinCursor % sorted.length
    this.roundRobinCursor += 1
    return [...sorted.slice(offset), ...sorted.slice(0, offset)]
  }

  private tryReserve(accountId: string): boolean {
    const active = this.activeByAccount.get(accountId) ?? 0
    if (active >= this.runtimeConfig.accountConcurrency) return false
    this.activeByAccount.set(accountId, active + 1)
    return true
  }

  private releaseAccount(accountId: string): void {
    const active = this.activeByAccount.get(accountId) ?? 0
    if (active <= 1) this.activeByAccount.delete(accountId)
    else this.activeByAccount.set(accountId, active - 1)
  }

  private recordSuccess(accountId: string): void {
    this.circuits.delete(accountId)
  }

  private recordFailure(
    accountId: string,
    status: number,
    retryAfterMs?: number,
  ): CircuitState {
    const previous = this.circuits.get(accountId) ?? { failures: 0, openedUntil: 0 }
    const failures = previous.failures + 1
    const shouldOpen = status === 429 || failures >= 3
    const baseCooldown = status === 429
      ? Math.min(15 * 60_000, Math.max(1000, retryAfterMs ?? 60_000))
      : Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, failures - 3))
    const jitter = shouldOpen
      ? Math.floor(baseCooldown * this.deterministicJitterRatio(accountId))
      : 0
    const state = {
      failures,
      openedUntil: shouldOpen
        ? Date.now() + Math.min(15 * 60_000, baseCooldown + jitter)
        : 0,
    }
    this.circuits.set(accountId, state)
    return state
  }

  private deterministicJitterRatio(accountId: string): number {
    const hash = [...accountId]
      .reduce((total, character) => total + character.charCodeAt(0), 0)
    return (hash % 11) / 100
  }
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'provider_authentication_failed'
  if (status === 429) return 'provider_rate_limited'
  if (status === 408 || status === 504) return 'provider_timeout'
  if (status >= 400 && status < 500) return 'provider_rejected_request'
  return 'provider_unavailable'
}

function canFailOver(status: number): boolean {
  return status === 401
    || status === 403
    || status === 408
    || status === 409
    || status === 429
    || status >= 500
}

export function isRoutingFailure(
  value: RoutedResult | RoutingFailure,
): value is RoutingFailure {
  return 'code' in value
}
