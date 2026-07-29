import type { Readable, Transform } from 'node:stream'
import type { RuntimeConfig } from '../../core/config.js'
import { requestForwarder, streamHandler } from '../../legacy/provider-runtime.js'
import type {
  AccountSelection,
  ChatCompletionRequest,
  ForwardResult,
  ProxyContext,
} from '../../main/proxy/types.js'
import type { Provider } from '../../main/store/types.js'
import { storeManager } from '../../main/store/store.js'
import { primeStream, type PrimedStream } from './streaming.js'

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
  createTransformStream: (model: string, requestId: string) => Transform
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
  createTransformStream(model, requestId) {
    return streamHandler.createTransformStream(model, requestId)
  },
}

export class ProviderRoutingEngine {
  private readonly activeByAccount = new Map<string, number>()
  private readonly circuits = new Map<string, CircuitState>()
  private readonly roundRobinCursor = new Map<string, number>()

  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    private readonly providerRuntime: ProviderRuntimeAdapter = defaultProviderRuntime,
    private readonly store: typeof storeManager = storeManager,
  ) {}

  async forward(
    request: ChatCompletionRequest,
    context: ProxyContext,
  ): Promise<RoutedResult | RoutingFailure> {
    const candidates = this.orderCandidates(this.getCandidates(request), request.model)
    if (candidates.length === 0) {
      return { status: 503, code: 'no_available_account' }
    }

    let attempts = 0
    let lastStatus = 502
    let rateLimitRetryAt: number | undefined
    for (const selection of candidates) {
      if (!this.tryReserve(selection.account.id)) continue
      attempts += 1

      const scopedContext: ProxyContext = {
        ...context,
        providerId: selection.provider.id,
        accountId: selection.account.id,
        actualModel: selection.actualModel,
      }

      const result = await this.providerRuntime.forwardChatCompletion(
        request,
        selection,
        scopedContext,
      )

      if (!result.success) {
        this.releaseAccount(selection.account.id)
        lastStatus = result.status ?? 502
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
        if (!this.canFailOver(lastStatus)) break
        continue
      }

      let primed: PrimedStream | undefined
      if (request.stream) {
        if (!result.stream) {
          this.releaseAccount(selection.account.id)
          this.recordFailure(selection.account.id, 502)
          continue
        }

        const output = result.skipTransform
          ? result.stream
          : (result.stream as Readable).pipe(
              this.providerRuntime.createTransformStream(
                selection.actualModel,
                context.requestId,
              ),
            )
        try {
          primed = await primeStream(output, this.runtimeConfig.firstByteTimeoutMs)
        } catch {
          this.releaseAccount(selection.account.id)
          this.recordFailure(selection.account.id, 504)
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
          if (success) this.recordSuccess(selection.account.id)
          else this.recordFailure(selection.account.id, 502)
          if (success) {
            this.store.updateAccount(selection.account.id, {
              lastUsed: Date.now(),
              requestCount: (selection.account.requestCount ?? 0) + 1,
              todayUsed: (selection.account.todayUsed ?? 0) + 1,
              status: 'active',
              errorMessage: undefined,
            })
          }
        },
      }
    }

    const retryAfterSeconds = lastStatus === 429
      ? Math.max(1, Math.ceil(((rateLimitRetryAt ?? Date.now() + 60_000) - Date.now()) / 1000))
      : undefined
    return {
      status: lastStatus === 429 ? 429 : 502,
      code: lastStatus === 429 ? 'provider_rate_limited' : 'upstream_unavailable',
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    }
  }

  getState(): {
    accountConcurrency: Array<{ accountId: string; active: number }>
    openCircuits: Array<{ accountId: string; openedUntil: number }>
  } {
    const now = Date.now()
    return {
      accountConcurrency: [...this.activeByAccount.entries()].map(([accountId, active]) => ({ accountId, active })),
      openCircuits: [...this.circuits.entries()]
        .filter(([, state]) => state.openedUntil > now)
        .map(([accountId, state]) => ({ accountId, openedUntil: state.openedUntil })),
    }
  }

  private getCandidates(request: ChatCompletionRequest): AccountSelection[] {
    const now = Date.now()
    const model = request.model
    const mapping = this.store.getConfig().modelMappings[model]
    const providers = this.store.getProviders().filter((provider) => provider.enabled)
    const candidates: AccountSelection[] = []

    for (const provider of providers) {
      if (mapping?.preferredProviderId && mapping.preferredProviderId !== provider.id) continue
      if (!this.providerSupportsModel(provider, model)) continue
      if (request.web_search && provider.capabilities?.webSearch === false) continue

      for (const account of this.store.getAccountsByProviderId(provider.id, true)) {
        if (account.status !== 'active') continue
        if (account.dailyLimit && (account.todayUsed ?? 0) >= account.dailyLimit) continue
        if ((this.activeByAccount.get(account.id) ?? 0) >= this.runtimeConfig.accountConcurrency) continue
        const circuit = this.circuits.get(account.id)
        if (circuit && circuit.openedUntil > now) continue

        candidates.push({
          provider,
          account,
          actualModel: this.mapModel(model, provider),
        })
      }
    }
    return candidates
  }

  private providerSupportsModel(provider: Provider, model: string): boolean {
    const effective = this.store.getEffectiveModels(provider.id)
    if (effective.length === 0) return true
    const normalized = model.toLowerCase()
    const mapping = this.store.getConfig().modelMappings[model]
    const values = [normalized, mapping?.actualModel.toLowerCase()].filter(
      (value): value is string => Boolean(value),
    )
    return effective.some((candidate) => values.some((value) => {
      const supported = candidate.displayName.toLowerCase()
      return supported.endsWith('*') ? value.startsWith(supported.slice(0, -1)) : value === supported
    }))
  }

  private mapModel(model: string, provider: Provider): string {
    const direct = this.store
      .getEffectiveModels(provider.id)
      .find((candidate) => candidate.displayName.toLowerCase() === model.toLowerCase())
    if (direct) return direct.actualModelId

    const mapping = this.store.getConfig().modelMappings[model]
    if (mapping && (!mapping.preferredProviderId || mapping.preferredProviderId === provider.id)) {
      return mapping.actualModel
    }
    return provider.modelMappings?.[model] ?? model
  }

  private orderCandidates(candidates: AccountSelection[], model: string): AccountSelection[] {
    const config = this.store.getConfig()
    const preferredAccount = config.modelMappings[model]?.preferredAccountId
    const groups = new Map<number, AccountSelection[]>()

    for (const candidate of candidates) {
      const priority = candidate.provider.routingPriority ?? 50
      const group = groups.get(priority) ?? []
      group.push(candidate)
      groups.set(priority, group)
    }

    const ordered: AccountSelection[] = []
    for (const priority of [...groups.keys()].sort((left, right) => left - right)) {
      const group = groups.get(priority) ?? []
      const sorted = group.sort((left, right) => {
        if (left.account.id === preferredAccount) return -1
        if (right.account.id === preferredAccount) return 1
        if (config.loadBalanceStrategy === 'fill-first') {
          return (left.account.todayUsed ?? 0) - (right.account.todayUsed ?? 0)
        }
        return left.account.createdAt - right.account.createdAt
      })

      if (config.loadBalanceStrategy !== 'round-robin' || sorted.length <= 1) {
        ordered.push(...sorted)
        continue
      }

      const cursorKey = `${model}:${priority}`
      const cursor = this.roundRobinCursor.get(cursorKey) ?? 0
      const offset = cursor % sorted.length
      this.roundRobinCursor.set(cursorKey, cursor + 1)
      ordered.push(...sorted.slice(offset), ...sorted.slice(0, offset))
    }
    return ordered
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

  private recordFailure(accountId: string, status: number, retryAfterMs?: number): CircuitState {
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
      openedUntil: shouldOpen ? Date.now() + Math.min(15 * 60_000, baseCooldown + jitter) : 0,
    }
    this.circuits.set(accountId, state)
    return state
  }

  private deterministicJitterRatio(accountId: string): number {
    const hash = [...accountId].reduce((total, character) => total + character.charCodeAt(0), 0)
    return (hash % 11) / 100
  }

  private canFailOver(status: number): boolean {
    return status === 401
      || status === 403
      || status === 408
      || status === 409
      || status === 429
      || status >= 500
  }
}

export function isRoutingFailure(
  value: RoutedResult | RoutingFailure,
): value is RoutingFailure {
  return 'code' in value
}
