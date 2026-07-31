import { pipeline } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import type { ChatCompletionRequest, ProxyContext } from '../../main/proxy/types.js'
import { storeManager } from '../../main/store/store.js'
import { ConcurrencyGate } from '../gateway/concurrency.js'
import {
  isRoutingFailure,
  ProviderRoutingEngine,
  type RoutedResult,
} from '../gateway/router.js'
import { parseChatRequest } from '../schemas/chat.js'
import { assertModelAllowed, requireApiScope } from '../security/api-auth.js'

function openAiError(
  reply: FastifyReply,
  status: number,
  message: string,
  code: string,
  type = 'api_error',
): FastifyReply {
  return reply.code(status).send({
    error: { message, type, code, param: null },
  })
}

function contextFor(
  request: FastifyRequest,
  chat: ChatCompletionRequest,
  signal: AbortSignal,
): ProxyContext {
  return {
    requestId: request.id,
    model: chat.model,
    startTime: Date.now(),
    isStream: chat.stream === true,
    signal,
  }
}

function validationError(reply: FastifyReply, error: ZodError): FastifyReply {
  const unsupported = error.issues
    .filter((issue) => issue.code === 'unrecognized_keys')
    .flatMap((issue) => issue.keys)
  if (unsupported.length > 0) {
    return openAiError(
      reply,
      400,
      `Unsupported request fields: ${[...new Set(unsupported)].sort().join(', ')}.`,
      'unsupported_feature',
      'invalid_request_error',
    )
  }
  return openAiError(
    reply,
    400,
    'The request body is invalid.',
    'invalid_request',
    'invalid_request_error',
  )
}

export async function registerOpenAiRoutes(
  app: FastifyInstance,
  routing: ProviderRoutingEngine,
  concurrency: ConcurrencyGate,
): Promise<void> {
  app.get('/v1/models', { preHandler: requireApiScope('models') }, async (_request, reply) => {
    const provider = storeManager.getProviderById('deepseek')
    const hasActiveAccount = storeManager
      .getAccountsByProviderId('deepseek')
      .some((account) => account.status === 'active')
    const models = provider?.enabled && hasActiveAccount
      ? storeManager.getEffectiveModels('deepseek')
      : []

    return reply.send({
      object: 'list',
      data: models
        .map((model) => model.displayName)
        .sort()
        .map((id) => ({
          id,
          object: 'model',
          created: 0,
          owned_by: 'deepseek-web',
        })),
    })
  })

  app.post('/v1/chat/completions', { preHandler: requireApiScope('chat') }, async (request, reply) => {
    try {
      const chat = parseChatRequest(request.body)
      return await executeChat(request, reply, chat, routing, concurrency)
    } catch (error) {
      if (error instanceof ZodError) return validationError(reply, error)
      request.log.warn({ requestId: request.id }, 'chat request validation failed')
      return openAiError(
        reply,
        400,
        'The request could not be accepted.',
        'invalid_request',
        'invalid_request_error',
      )
    }
  })
}

async function executeChat(
  request: FastifyRequest,
  reply: FastifyReply,
  chat: ChatCompletionRequest,
  routing: ProviderRoutingEngine,
  concurrency: ConcurrencyGate,
): Promise<unknown> {
  if (!assertModelAllowed(request, chat.model)) {
    return openAiError(
      reply,
      403,
      'This API key cannot use the requested model.',
      'model_not_allowed',
    )
  }

  const releaseGlobal = concurrency.tryAcquire()
  if (!releaseGlobal) {
    return openAiError(
      reply,
      503,
      'The gateway is at capacity. Try again shortly.',
      'gateway_at_capacity',
    )
  }

  const controller = new AbortController()
  let settled = false
  const abort = () => {
    if (!settled && !reply.raw.writableEnded) controller.abort()
  }
  request.raw.once('aborted', abort)
  reply.raw.once('close', abort)

  const requestLog = storeManager.startRequestLog({
    requestId: request.id,
    method: request.method,
    url: request.routeOptions.url ?? request.url,
    model: chat.model,
    apiKeyId: request.apiKey?.id,
    isStream: chat.stream === true,
  })
  const startedAt = Date.now()
  let routed: RoutedResult | undefined

  const detachAbortListeners = () => {
    request.raw.off('aborted', abort)
    reply.raw.off('close', abort)
  }

  try {
    const result = await routing.forward(
      chat,
      contextFor(request, chat, controller.signal),
    )
    if (isRoutingFailure(result)) {
      settled = true
      detachAbortListeners()
      if (result.retryAfterSeconds !== undefined) {
        reply.header('Retry-After', String(result.retryAfterSeconds))
      }
      storeManager.finishRequestLog(requestLog.id, {
        status: 'error',
        statusCode: result.status,
        latency: Date.now() - startedAt,
        errorCode: result.code,
      })
      releaseGlobal()
      return openAiError(
        reply,
        result.status,
        publicErrorMessage(result.code),
        result.code,
      )
    }
    routed = result

    if (chat.stream) {
      if (!result.primed) throw new Error('Primed stream is unavailable')
      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': request.id,
      })
      reply.raw.write(result.primed.firstChunk)

      const disconnect = () => {
        if (reply.raw.writableEnded) return
        controller.abort()
        result.primed?.stream.destroy()
      }
      request.raw.once('aborted', disconnect)
      reply.raw.once('close', disconnect)
      pipeline(result.primed.stream, reply.raw, (error) => {
        settled = true
        request.raw.off('aborted', disconnect)
        reply.raw.off('close', disconnect)
        detachAbortListeners()
        const success = !error
        result.release(success)
        releaseGlobal()
        storeManager.finishRequestLog(requestLog.id, {
          status: success ? 'success' : 'error',
          statusCode: success ? 200 : controller.signal.aborted ? 499 : 502,
          latency: Date.now() - startedAt,
          actualModel: result.selection.actualModel,
          providerId: result.selection.provider.id,
          accountId: result.selection.account.id,
          errorCode: success
            ? undefined
            : controller.signal.aborted
              ? 'client_aborted'
              : 'stream_interrupted',
        })
      })
      return undefined
    }

    settled = true
    detachAbortListeners()
    result.release(true)
    releaseGlobal()
    storeManager.finishRequestLog(requestLog.id, {
      status: 'success',
      statusCode: 200,
      latency: Date.now() - startedAt,
      actualModel: result.selection.actualModel,
      providerId: result.selection.provider.id,
      accountId: result.selection.account.id,
    })
    return reply.send(result.result.body)
  } catch {
    settled = true
    detachAbortListeners()
    routed?.release(false)
    releaseGlobal()
    const aborted = controller.signal.aborted
    storeManager.finishRequestLog(requestLog.id, {
      status: 'error',
      statusCode: aborted ? 499 : 500,
      latency: Date.now() - startedAt,
      actualModel: routed?.selection.actualModel,
      providerId: routed?.selection.provider.id,
      accountId: routed?.selection.account.id,
      errorCode: aborted ? 'client_aborted' : 'gateway_error',
    })
    if (reply.sent || reply.raw.destroyed) return undefined
    return openAiError(
      reply,
      aborted ? 499 : 500,
      aborted
        ? 'The client closed the request.'
        : 'The gateway could not complete the request.',
      aborted ? 'client_aborted' : 'gateway_error',
    )
  }
}

function publicErrorMessage(code: string): string {
  if (code === 'provider_authentication_failed') {
    return 'The configured DeepSeek session requires attention.'
  }
  if (code === 'provider_rate_limited') {
    return 'DeepSeek is rate limited. Try again later.'
  }
  if (code === 'provider_account_suspended') {
    return 'The configured DeepSeek account is temporarily suspended by the provider.'
  }
  if (code === 'provider_timeout') {
    return 'DeepSeek did not respond in time.'
  }
  if (code === 'provider_protocol_changed') {
    return 'The DeepSeek web protocol changed and requires an adapter update.'
  }
  if (code === 'no_available_account') {
    return 'No healthy DeepSeek account is currently available.'
  }
  return 'DeepSeek is currently unavailable.'
}
