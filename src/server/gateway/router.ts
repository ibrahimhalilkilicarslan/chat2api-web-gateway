import type { Readable } from 'node:stream'
import type { RuntimeConfig } from '../../core/config.js'
import { requestForwarder } from '../../main/proxy/forwarder.js'
import type {
  AccountSelection,
  ChatCompletionRequest,
  ForwardResult,
  ForwardStreamOutcome,
  ProxyContext,
} from '../../main/proxy/types.js'
import { storeManager } from '../../main/store/store.js'
import { ConcurrencyGate } from './concurrency.js'
import { enforceIdleTimeout, primeStream, type PrimedStream } from './streaming.js'

interface CircuitState {
  failures: number
  openedUntil: number
  code?: string
}

interface ReservedSelection {
  selection: AccountSelection
  release: () => void
}

interface AccountFailureOutcome {
  status: number
  code: string
  retryAfterMs?: number
  latencyMs: number
}

export interface ProviderRoutingHooks {
  getAccountIdentityFingerprint?: (accountId: string) => string | undefined
  onAccountSuspended?: (input: {
    accountId: string
    message: string
    retryAt?: number
    latencyMs: number
  }) => void
}

export interface RoutedResult {
  result: ForwardResult
  selection: AccountSelection
  primed?: PrimedStream
  release: (success: boolean, failure?: ForwardStreamOutcome) => void
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
  private readonly accountGates = new Map<string, ConcurrencyGate>()
  private readonly circuits = new Map<string, CircuitState>()
  private roundRobinCursor = 0

  constructor(
    private readonly runtimeConfig: RuntimeConfig,
    private readonly providerRuntime: ProviderRuntimeAdapter = defaultProviderRuntime,
    private readonly store: typeof storeManager = storeManager,
    private readonly hooks: ProviderRoutingHooks = {},
  ) {}

  async forward(
    request: ChatCompletionRequest,
    context: ProxyContext,
  ): Promise<RoutedResult | RoutingFailure> {
    if (this.getCandidates(request).length === 0) {
      return this.unavailableRoutingFailure(request)
    }

    let attempts = 0
    let lastStatus = 502
    let lastCode = 'provider_unavailable'
    let rateLimitRetryAt: number | undefined
    let suspensionRetryAt: number | undefined

    const attemptedAccounts = new Set<string>()
    while (true) {
      const candidates = this.orderCandidates(this.getCandidates(request))
        .filter((selection) => !attemptedAccounts.has(selection.account.id))
      if (candidates.length === 0) break

      const reserved = await this.reserveCandidate(request, candidates, context)
      if (reserved && 'code' in reserved) {
        if (attempts > 0) break
        return reserved
      }
      if (!reserved) {
        return context.signal?.aborted
          ? { status: 499, code: 'provider_request_cancelled' }
          : { status: 503, code: 'account_queue_timeout', retryAfterSeconds: 1 }
      }
      const { selection, release: releaseAccount } = reserved
      attemptedAccounts.add(selection.account.id)
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
        releaseAccount()
        lastStatus = result.status ?? 502
        lastCode = result.code ?? statusCode(lastStatus)
        if (lastCode === 'invalid_media_input') {
          return { status: lastStatus, code: lastCode }
        }
        if (lastCode === 'provider_expert_busy') {
          const circuit = this.recordFailure(
            selection.account.id,
            lastStatus,
            result.retryAfterMs,
            lastCode,
          )
          const hasAlternative = attempts < 2 && this.getCandidates(request)
            .some((candidate) => !attemptedAccounts.has(candidate.account.id))
          if (hasAlternative) continue
          return {
            status: 503,
            code: lastCode,
            retryAfterSeconds: Math.max(
              1,
              Math.ceil((circuit.openedUntil - Date.now()) / 1000),
            ),
          }
        }
        const circuit = this.handleAccountFailure(selection, {
          status: lastStatus,
          code: lastCode,
          retryAfterMs: result.retryAfterMs,
          latencyMs: result.latency ?? 0,
        })
        if (lastStatus === 429 && circuit.openedUntil > 0) {
          rateLimitRetryAt = rateLimitRetryAt === undefined
            ? circuit.openedUntil
            : Math.min(rateLimitRetryAt, circuit.openedUntil)
        }
        if (lastCode === 'provider_account_suspended') {
          const retryAt = result.retryAfterMs === undefined
            ? undefined
            : Date.now() + result.retryAfterMs
          if (retryAt !== undefined) {
            suspensionRetryAt = suspensionRetryAt === undefined
              ? retryAt
              : Math.min(suspensionRetryAt, retryAt)
          }
        }
        if (!canFailOver(lastStatus)) break
        continue
      }

      let primed: PrimedStream | undefined
      if (request.stream) {
        if (!result.stream) {
          releaseAccount()
          this.recordFailure(selection.account.id, 502, undefined, 'provider_protocol_changed')
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
          releaseAccount()
          this.recordFailure(selection.account.id, 504, undefined, 'provider_timeout')
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
        release: (success, failure) => {
          if (released) return
          released = true
          releaseAccount()
          if (success) {
            this.recordSuccess(selection.account.id)
            this.store.updateAccount(selection.account.id, {
              lastUsed: Date.now(),
              requestCount: (selection.account.requestCount ?? 0) + 1,
              todayUsed: (selection.account.todayUsed ?? 0) + 1,
              status: 'active',
              errorMessage: undefined,
            })
          } else if (failure?.code !== 'provider_expert_busy') {
            const failureStatus = failure?.status ?? 502
            this.handleAccountFailure(selection, {
              status: failureStatus,
              code: failure?.code ?? statusCode(failureStatus),
              retryAfterMs: failure?.retryAfterMs,
              latencyMs: result.latency ?? 0,
            })
          }
        },
      }
    }

    const retryAt = lastCode === 'provider_account_suspended'
      ? suspensionRetryAt
      : lastStatus === 429
        ? rateLimitRetryAt ?? Date.now() + 60_000
        : undefined
    const retryAfterSeconds = retryAt === undefined
      ? undefined
      : Math.max(1, Math.ceil((retryAt - Date.now()) / 1000))
    return {
      status: lastCode === 'provider_account_suspended'
        ? 503
        : lastStatus === 429
          ? 429
          : lastStatus === 504
            ? 504
            : 502,
      code: lastCode,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    }
  }

  getState(): {
    accountConcurrency: Array<{ accountId: string; active: number }>
    accountQueue: Array<{ accountId: string; foreground: number; background: number }>
    openCircuits: Array<{ accountId: string; failures: number; openedUntil: number; code?: string }>
    deepSeekSessions: ReturnType<typeof requestForwarder.getState>['deepSeekSessions']
  } {
    const now = Date.now()
    return {
      accountConcurrency: [...this.accountGates.entries()]
        .filter(([, gate]) => gate.getActive() > 0)
        .map(([accountId, gate]) => ({ accountId, active: gate.getActive() })),
      accountQueue: [...this.accountGates.entries()]
        .map(([accountId, gate]) => ({ accountId, ...gate.getQueueState() }))
        .filter((entry) => entry.foreground > 0 || entry.background > 0),
      openCircuits: [...this.circuits.entries()]
        .filter(([, state]) => state.openedUntil > now)
        .map(([accountId, state]) => ({
          accountId,
          failures: state.failures,
          openedUntil: state.openedUntil,
          code: state.code,
        })),
      deepSeekSessions: requestForwarder.getState().deepSeekSessions,
    }
  }

  markAccountHealthy(accountId: string): void {
    this.recordSuccess(accountId)
  }

  private getCandidates(request: ChatCompletionRequest): AccountSelection[] {
    const provider = this.store.getProviderById('deepseek')
    if (!provider?.enabled || !this.providerSupportsModel(provider, request.model)) return []

    const now = Date.now()
    const seenProviderIdentities = new Set<string>()
    return this.store.getAccountsByProviderId('deepseek', true)
      .filter((account) => account.status === 'active')
      .map((account) => {
        const usage = this.store.getAccountUsageWindow(
          account.id,
          this.runtimeConfig.accountUsageWindowMs,
          now,
        )
        return {
          ...account,
          usageWindowUsed: usage.used,
          usageWindowResetAt: usage.resetAt,
        }
      })
      .filter((account) => !account.dailyLimit || (account.usageWindowUsed ?? 0) < account.dailyLimit)
      .filter((account) => (this.circuits.get(account.id)?.openedUntil ?? 0) <= now)
      .filter((account) => {
        const fingerprint = this.hooks.getAccountIdentityFingerprint?.(account.id)
        if (!fingerprint) return true
        if (seenProviderIdentities.has(fingerprint)) return false
        seenProviderIdentities.add(fingerprint)
        return true
      })
      .map((account) => ({
        provider,
        account,
        actualModel: this.mapModel(request.model, provider),
      }))
  }

  private unavailableRoutingFailure(request: ChatCompletionRequest): RoutingFailure {
    const provider = this.store.getProviderById('deepseek')
    if (!provider?.enabled || !this.providerSupportsModel(provider, request.model)) {
      return { status: 503, code: 'no_available_account' }
    }

    const now = Date.now()
    const activeAccounts = this.store.getAccountsByProviderId('deepseek', true)
      .filter((account) => account.status === 'active')
      .map((account) => {
        const usage = this.store.getAccountUsageWindow(
          account.id,
          this.runtimeConfig.accountUsageWindowMs,
          now,
        )
        return {
          ...account,
          usageWindowUsed: usage.used,
          usageWindowResetAt: usage.resetAt,
        }
      })

    const otherwiseEligible = activeAccounts
      .filter((account) => !account.dailyLimit || (account.usageWindowUsed ?? 0) < account.dailyLimit)

    if (activeAccounts.length > 0 && otherwiseEligible.length === 0) {
      const retryAt = activeAccounts
        .map((account) => account.usageWindowResetAt)
        .filter((value): value is number => typeof value === 'number' && value > now)
        .sort((left, right) => left - right)[0]
      return {
        status: 429,
        code: 'account_usage_window_exhausted',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(((retryAt ?? now + this.runtimeConfig.accountUsageWindowMs) - now) / 1000),
        ),
      }
    }

    if (otherwiseEligible.length === 0) {
      return { status: 503, code: 'no_available_account' }
    }

    const activeCircuits = otherwiseEligible
      .map((account) => this.circuits.get(account.id))
      .filter((circuit): circuit is CircuitState => Boolean(circuit && circuit.openedUntil > now))

    if (activeCircuits.length !== otherwiseEligible.length) {
      return { status: 503, code: 'no_available_account' }
    }

    const earliest = [...activeCircuits].sort((left, right) => left.openedUntil - right.openedUntil)[0]
    const code = earliest?.code || 'provider_unavailable'
    const status = code === 'provider_rate_limited'
      ? 429
      : code === 'provider_timeout'
        ? 504
        : 503
    return {
      status,
      code,
      retryAfterSeconds: Math.max(1, Math.ceil((earliest.openedUntil - now) / 1000)),
    }
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
        return (left.account.usageWindowUsed ?? 0) - (right.account.usageWindowUsed ?? 0)
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

  private async reserveCandidate(
    request: ChatCompletionRequest,
    candidates: AccountSelection[],
    context: ProxyContext,
  ): Promise<ReservedSelection | RoutingFailure | undefined> {
    if (
      context.priority === 'background'
      && (
        this.runtimeConfig.backgroundAccountReserve > 0
        || this.runtimeConfig.backgroundUsageReserve > 0
      )
    ) {
      return this.reserveBackgroundCandidate(candidates)
    }

    for (const selection of candidates) {
      const release = this.gateFor(selection.account.id).tryAcquire()
      if (!release) continue
      const reserved = this.consumeUsageWindow(selection, release)
      if (reserved) return reserved
    }

    const target = [...candidates].sort((left, right) => (
      this.gateFor(left.account.id).getQueued()
      - this.gateFor(right.account.id).getQueued()
    ))[0]
    if (!target) return undefined

    const release = await this.gateFor(target.account.id).acquire({
      priority: context.priority,
      signal: context.signal,
      timeoutMs: this.runtimeConfig.queueTimeoutMs,
    })
    if (!release) return undefined

    const stillEligible = this.getCandidates(request)
      .some((selection) => selection.account.id === target.account.id)
    if (!stillEligible) {
      release()
      return undefined
    }
    return this.consumeUsageWindow(target, release)
  }

  private reserveBackgroundCandidate(
    candidates: AccountSelection[],
  ): ReservedSelection | RoutingFailure {
    const backgroundCandidates = candidates.filter((selection) => {
      const usageLimit = Number(selection.account.dailyLimit) || 0
      if (usageLimit <= 0) return true
      return (selection.account.usageWindowUsed ?? 0)
        < usageLimit - this.runtimeConfig.backgroundUsageReserve
    })
    if (backgroundCandidates.length === 0) {
      return {
        status: 503,
        code: 'background_usage_capacity_reserved',
        retryAfterSeconds: this.nextUsageRetrySeconds(candidates),
      }
    }

    const idleAccounts = candidates.filter(
      (selection) => this.gateFor(selection.account.id).getActive() === 0,
    ).length
    const available = backgroundCandidates
      .filter((selection) => (
        this.gateFor(selection.account.id).getActive()
        < this.runtimeConfig.accountConcurrency
      ))
      // Reuse spare capacity before consuming a completely idle account.
      .sort((left, right) => (
        Number(this.gateFor(left.account.id).getActive() === 0)
        - Number(this.gateFor(right.account.id).getActive() === 0)
      ))

    for (const selection of available) {
      const gate = this.gateFor(selection.account.id)
      const consumesIdleAccount = gate.getActive() === 0
      if (
        consumesIdleAccount
        && idleAccounts <= this.runtimeConfig.backgroundAccountReserve
      ) {
        continue
      }
      const release = gate.tryAcquire()
      if (!release) continue
      const reserved = this.consumeUsageWindow(selection, release)
      if (reserved) return reserved
    }

    return {
      status: 503,
      code: 'background_capacity_reserved',
      retryAfterSeconds: 30,
    }
  }

  private gateFor(accountId: string): ConcurrencyGate {
    const existing = this.accountGates.get(accountId)
    if (existing) return existing
    const gate = new ConcurrencyGate(
      this.runtimeConfig.accountConcurrency,
      this.runtimeConfig.queueMaxDepth,
    )
    this.accountGates.set(accountId, gate)
    return gate
  }

  private consumeUsageWindow(
    selection: AccountSelection,
    release: () => void,
  ): ReservedSelection | undefined {
    const usage = this.store.consumeAccountUsageWindow(
      selection.account.id,
      selection.account.dailyLimit,
      this.runtimeConfig.accountUsageWindowMs,
    )
    if (!usage.allowed) {
      release()
      return undefined
    }
    return {
      selection: {
        ...selection,
        account: {
          ...selection.account,
          usageWindowUsed: usage.used,
          usageWindowResetAt: usage.resetAt,
        },
      },
      release,
    }
  }

  private nextUsageRetrySeconds(candidates: AccountSelection[]): number {
    const now = Date.now()
    const retryAt = candidates
      .map((selection) => selection.account.usageWindowResetAt)
      .filter((value): value is number => typeof value === 'number' && value > now)
      .sort((left, right) => left - right)[0]
    return Math.max(
      1,
      Math.ceil(((retryAt ?? now + this.runtimeConfig.accountUsageWindowMs) - now) / 1000),
    )
  }

  private recordSuccess(accountId: string): void {
    this.circuits.delete(accountId)
  }

  private handleAccountFailure(
    selection: AccountSelection,
    failure: AccountFailureOutcome,
  ): CircuitState {
    const circuit = this.recordFailure(
      selection.account.id,
      failure.status,
      failure.retryAfterMs,
      failure.code,
    )
    if (failure.code === 'provider_account_suspended') {
      const retryAt = failure.retryAfterMs === undefined
        ? undefined
        : Date.now() + failure.retryAfterMs
      const message = 'The DeepSeek account is temporarily suspended by the provider.'
      this.store.updateAccount(selection.account.id, {
        status: 'error',
        errorMessage: message,
      })
      this.hooks.onAccountSuspended?.({
        accountId: selection.account.id,
        message,
        retryAt,
        latencyMs: failure.latencyMs,
      })
    } else if (failure.code === 'provider_authentication_failed') {
      this.store.updateAccount(selection.account.id, {
        status: 'error',
        errorMessage: 'Provider authentication requires attention.',
      })
    }
    return circuit
  }

  private recordFailure(
    accountId: string,
    status: number,
    retryAfterMs?: number,
    code?: string,
  ): CircuitState {
    const previous = this.circuits.get(accountId) ?? { failures: 0, openedUntil: 0 }
    const failures = previous.failures + 1
    const suspended = code === 'provider_account_suspended'
    const expertBusy = code === 'provider_expert_busy'
    const shouldOpen = suspended || expertBusy || status === 429 || failures >= 3
    const baseCooldown = suspended
      ? Math.min(24 * 60 * 60_000, Math.max(1000, retryAfterMs ?? 15 * 60_000))
      : expertBusy
        ? Math.min(5 * 60_000, Math.max(1000, retryAfterMs ?? 30_000))
      : status === 429
        ? Math.min(15 * 60_000, Math.max(1000, retryAfterMs ?? 60_000))
      : Math.min(10 * 60_000, 15_000 * 2 ** Math.max(0, failures - 3))
    const jitter = shouldOpen && !suspended
      ? Math.floor(baseCooldown * this.deterministicJitterRatio(accountId))
      : 0
    const state = {
      failures,
      openedUntil: shouldOpen
        ? Date.now() + (suspended
            ? baseCooldown
            : Math.min(15 * 60_000, baseCooldown + jitter))
        : 0,
      code,
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
