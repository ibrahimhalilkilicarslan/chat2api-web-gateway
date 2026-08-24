import type { Account, Provider } from '../store/types'
import {
  DeepSeekAdapter,
  DeepSeekUpstreamError,
} from './adapters/deepseek'
import {
  DeepSeekProviderError,
  DeepSeekStreamHandler,
  type DeepSeekStreamOutcome,
  providerErrorFromJsonResponse,
} from './adapters/deepseek-stream'
import { parseRetryAfterMs } from './retry-after'
import type {
  ChatCompletionRequest,
  ForwardResult,
  ForwardStreamOutcome,
  ProxyContext,
} from './types'

export class RequestForwarder {
  private requestTimeoutMs = 120_000
  private sessionTtlMs = 300_000

  configure(options: { requestTimeoutMs: number; sessionTtlMs?: number }): void {
    this.requestTimeoutMs = options.requestTimeoutMs
    this.sessionTtlMs = options.sessionTtlMs ?? this.sessionTtlMs
  }

  getState(): { deepSeekSessions: ReturnType<typeof DeepSeekAdapter.sessionPoolState> } {
    return { deepSeekSessions: DeepSeekAdapter.sessionPoolState() }
  }

  async forwardChatCompletion(
    request: ChatCompletionRequest,
    account: Account,
    provider: Provider,
    _actualModel: string,
    context: ProxyContext,
  ): Promise<ForwardResult> {
    const startedAt = Date.now()
    if (!DeepSeekAdapter.isDeepSeekProvider(provider)) {
      return {
        success: false,
        status: 400,
        code: 'unsupported_provider',
        error: 'Only the DeepSeek web provider is supported.',
        latency: Date.now() - startedAt,
      }
    }

    const adapter = new DeepSeekAdapter(provider, account, {
      requestTimeoutMs: this.requestTimeoutMs,
      sessionTtlMs: this.sessionTtlMs,
    })

    try {
      const { response, sessionId } = await adapter.chatCompletion({
        model: request.model,
        messages: request.messages,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      }, context.signal)
      const finalizeSession = async (outcome: DeepSeekStreamOutcome) => {
        if (
          outcome.status === 'success'
          || outcome.errorCode === 'provider_account_suspended'
          || outcome.errorCode === 'provider_rate_limited'
          || outcome.errorCode === 'provider_expert_busy'
        ) {
          await adapter.releaseSession(sessionId)
          return
        }
        await adapter.invalidateSession(sessionId)
      }

      if (response.status >= 400) {
        let body = ''
        try {
          body = await readBoundedProviderBody(response.data)
        } catch (error) {
          await finalizeSession({ status: 'interrupted' })
          throw error
        }
        const providerError = providerErrorFromJsonResponse(body)
        const code = providerError?.code ?? statusCode(response.status)
        await finalizeSession({ status: 'provider_error', errorCode: code })
        return {
          success: false,
          status: providerError?.status ?? response.status,
          code,
          retryAfterMs: providerError?.retryAfterMs
            ?? parseRetryAfterMs(response.headers?.['retry-after']),
          error: providerError?.message ?? 'DeepSeek rejected the request.',
          latency: Date.now() - startedAt,
        }
      }

      const contentType = String(response.headers?.['content-type'] ?? '').toLowerCase()
      if (contentType.includes('application/json')) {
        let body = ''
        try {
          body = await readBoundedProviderBody(response.data)
        } catch (error) {
          await finalizeSession({ status: 'interrupted' })
          throw error
        }
        const providerError = providerErrorFromJsonResponse(body)
        if (providerError) {
          await finalizeSession({ status: 'provider_error', errorCode: providerError.code })
          throw providerError
        }
        await finalizeSession({ status: 'provider_error', errorCode: 'provider_protocol_changed' })
        throw new DeepSeekProviderError(
          'provider_protocol_changed',
          502,
          'DeepSeek returned an unexpected JSON response.',
        )
      }

      const handler = new DeepSeekStreamHandler(
        request.model,
        finalizeSession,
        request.web_search,
        request.reasoning_effort,
      )

      if (request.stream) {
        return {
          success: true,
          status: 200,
          stream: handler.handleStream(response.data),
          streamOutcome: handler.outcome.then(mapStreamOutcome),
          latency: Date.now() - startedAt,
        }
      }

      return {
        success: true,
        status: 200,
        body: await handler.handleNonStream(response.data),
        latency: Date.now() - startedAt,
      }
    } catch (error) {
      const failure = normalizeError(error)
      return {
        success: false,
        status: failure.status,
        code: failure.code,
        retryAfterMs: failure.retryAfterMs
          ?? (failure.status === 429 ? 60_000 : undefined),
        error: failure.message,
        latency: Date.now() - startedAt,
      }
    }
  }
}

function mapStreamOutcome(outcome: DeepSeekStreamOutcome): ForwardStreamOutcome {
  if (outcome.status === 'success') return { success: true, status: 200 }
  return {
    success: false,
    status: outcome.statusCode ?? 502,
    code: outcome.errorCode ?? (outcome.status === 'interrupted'
      ? 'stream_interrupted'
      : 'provider_response_error'),
    ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
  }
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) return 'provider_authentication_failed'
  if (status === 408 || status === 504) return 'provider_timeout'
  if (status === 429) return 'provider_rate_limited'
  if (status >= 500) return 'provider_unavailable'
  return 'provider_rejected_request'
}

function normalizeError(error: unknown): {
  code: string
  status: number
  message: string
  retryAfterMs?: number
} {
  if (error instanceof DeepSeekUpstreamError || error instanceof DeepSeekProviderError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
      ...(error.retryAfterMs !== undefined
        ? { retryAfterMs: error.retryAfterMs }
        : {}),
    }
  }
  return {
    code: 'provider_unavailable',
    status: 502,
    message: 'DeepSeek is currently unavailable.',
  }
}

async function readBoundedProviderBody(
  stream: NodeJS.ReadableStream,
  maximumBytes = 64 * 1024,
): Promise<string> {
  let body = ''
  for await (const chunk of stream) {
    body += chunk.toString()
    if (Buffer.byteLength(body) > maximumBytes) {
      throw new DeepSeekProviderError(
        'provider_protocol_changed',
        502,
        'DeepSeek returned an oversized JSON response.',
      )
    }
  }
  return body
}

export const requestForwarder = new RequestForwarder()
