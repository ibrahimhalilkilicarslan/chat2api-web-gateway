import type { Account, Provider } from '../store/types'
import {
  DeepSeekAdapter,
  DeepSeekUpstreamError,
} from './adapters/deepseek'
import {
  DeepSeekProviderError,
  DeepSeekStreamHandler,
} from './adapters/deepseek-stream'
import { parseRetryAfterMs } from './retry-after'
import type {
  ChatCompletionRequest,
  ForwardResult,
  ProxyContext,
} from './types'

export class RequestForwarder {
  private requestTimeoutMs = 120_000

  configure(options: { requestTimeoutMs: number }): void {
    this.requestTimeoutMs = options.requestTimeoutMs
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
    })

    try {
      const { response, sessionId } = await adapter.chatCompletion({
        model: request.model,
        messages: request.messages,
        web_search: request.web_search,
        reasoning_effort: request.reasoning_effort,
      }, context.signal)
      const cleanup = async () => {
        await adapter.deleteSession(sessionId)
      }

      if (response.status >= 400) {
        await cleanup()
        return {
          success: false,
          status: response.status,
          code: statusCode(response.status),
          retryAfterMs: parseRetryAfterMs(response.headers?.['retry-after']),
          error: 'DeepSeek rejected the request.',
          latency: Date.now() - startedAt,
        }
      }

      const handler = new DeepSeekStreamHandler(
        request.model,
        cleanup,
        request.web_search,
        request.reasoning_effort,
      )

      if (request.stream) {
        return {
          success: true,
          status: 200,
          stream: handler.handleStream(response.data),
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
        retryAfterMs: failure.status === 429 ? 60_000 : undefined,
        error: failure.message,
        latency: Date.now() - startedAt,
      }
    }
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
} {
  if (error instanceof DeepSeekUpstreamError || error instanceof DeepSeekProviderError) {
    return {
      code: error.code,
      status: error.status,
      message: error.message,
    }
  }
  return {
    code: 'provider_unavailable',
    status: 502,
    message: 'DeepSeek is currently unavailable.',
  }
}

export const requestForwarder = new RequestForwarder()
