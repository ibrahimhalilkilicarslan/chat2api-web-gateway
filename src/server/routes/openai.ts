import { pipeline } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import type {
  ChatCompletionRequest,
  ForwardStreamOutcome,
  ProxyContext,
} from '../../main/proxy/types.js'
import { storeManager } from '../../main/store/store.js'
import { ConcurrencyGate } from '../gateway/concurrency.js'
import {
  isRoutingFailure,
  ProviderRoutingEngine,
  type RoutedResult,
} from '../gateway/router.js'
import { parseChatRequest } from '../schemas/chat.js'
import { applyStopSequences, listModelAliases, parseToolCalls, toolNames } from '../schemas/openaiCompat.js'
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
    priority: request.headers['x-chat2api-priority'] === 'background'
      ? 'background'
      : 'foreground',
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

    const realIds = models.map((model) => model.displayName)
    const realIdSet = new Set(realIds.map((id) => id.toLowerCase()))
    // Advertise OpenAI-compat aliases only when they resolve to an available model,
    // so clients can discover drop-in names alongside the native ids.
    const aliasIds = realIds.length > 0
      ? listModelAliases()
        .filter(({ target }) => realIdSet.has(target.toLowerCase()))
        .map(({ alias }) => alias)
      : []

    return reply.send({
      object: 'list',
      data: [...new Set([...realIds, ...aliasIds])]
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

  const controller = new AbortController()
  let settled = false
  const abort = () => {
    if (!settled && !reply.raw.writableEnded) controller.abort()
  }
  request.raw.once('aborted', abort)
  reply.raw.once('close', abort)

  const releaseGlobal = await concurrency.acquire({
    priority: request.headers['x-chat2api-priority'] === 'background'
      ? 'background'
      : 'foreground',
    signal: controller.signal,
  })
  if (!releaseGlobal) {
    settled = true
    request.raw.off('aborted', abort)
    reply.raw.off('close', abort)
    return openAiError(
      reply,
      controller.signal.aborted ? 499 : 503,
      controller.signal.aborted
        ? 'The client closed the request.'
        : 'The gateway queue is full or timed out. Try again shortly.',
      controller.signal.aborted ? 'client_aborted' : 'gateway_at_capacity',
    )
  }

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

      const finalizeStream = async (pipelineError?: Error | null) => {
        let completion: ForwardStreamOutcome = pipelineError
          ? { success: false, status: 502, code: 'stream_interrupted' }
          : { success: true, status: 200 }
        if (!pipelineError && result.result.streamOutcome) {
          try {
            completion = await result.result.streamOutcome
          } catch {
            completion = { success: false, status: 502, code: 'stream_interrupted' }
          }
        }

        settled = true
        request.raw.off('aborted', disconnect)
        reply.raw.off('close', disconnect)
        detachAbortListeners()
        const aborted = controller.signal.aborted
        const success = !pipelineError && completion.success
        result.release(success, success ? undefined : completion)
        releaseGlobal()
        storeManager.finishRequestLog(requestLog.id, {
          status: success ? 'success' : 'error',
          statusCode: success ? 200 : aborted ? 499 : completion.status,
          latency: Date.now() - startedAt,
          actualModel: result.selection.actualModel,
          providerId: result.selection.provider.id,
          accountId: result.selection.account.id,
          errorCode: success
            ? undefined
            : aborted
              ? 'client_aborted'
              : completion.code ?? 'stream_interrupted',
        })
      }
      pipeline(result.primed.stream, reply.raw, (error) => {
        void finalizeStream(error)
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
    return reply.send(
      applyStopToCompletionBody(applyToolCallsToBody(result.result.body, chat), chat.stop),
    )
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

// Best-effort application of OpenAI `stop` sequences to a non-stream completion
// body. DeepSeek web does not honor stop natively; when a stop marker is found
// the assistant text is truncated and the choice is marked as stopped.
function applyStopToCompletionBody(body: unknown, stop: string[] | undefined): unknown {
  if (!stop || stop.length === 0 || body === null || typeof body !== 'object') {
    return body
  }
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return body
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const message = (choice as { message?: unknown }).message
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (typeof content !== 'string') continue
    const truncated = applyStopSequences(content, stop)
    if (truncated !== content) {
      ;(message as { content: string }).content = truncated
      ;(choice as { finish_reason?: unknown }).finish_reason = 'stop'
    }
  }
  return body
}

// Emulated tool calling: when tools were requested, parse the model's tool
// envelope out of the non-stream assistant content into OpenAI `tool_calls`.
// Runs only when tools are present, so normal completions are untouched.
function applyToolCallsToBody(body: unknown, chat: ChatCompletionRequest): unknown {
  const tools = chat.tools
  if (!tools || tools.length === 0 || body === null || typeof body !== 'object') return body
  const allowed = toolNames(tools)
  if (allowed.length === 0) return body
  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices)) return body
  for (const choice of choices) {
    if (!choice || typeof choice !== 'object') continue
    const message = (choice as { message?: unknown }).message
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (typeof content !== 'string') continue
    const toolCalls = parseToolCalls(content, allowed)
    if (toolCalls) {
      ;(message as Record<string, unknown>).content = null
      ;(message as Record<string, unknown>).tool_calls = toolCalls
      ;(choice as Record<string, unknown>).finish_reason = 'tool_calls'
    }
  }
  return body
}

function publicErrorMessage(code: string): string {
  if (code === 'invalid_media_input') {
    return 'The attached file is invalid, unsupported, or exceeds the configured limit.'
  }
  if (code === 'provider_media_upload_failed') {
    return 'DeepSeek could not accept the attached file.'
  }
  if (code === 'provider_media_processing_timeout') {
    return 'DeepSeek did not finish processing the attached file in time.'
  }
  if (code === 'provider_authentication_failed') {
    return 'The configured DeepSeek session requires attention.'
  }
  if (code === 'provider_rate_limited') {
    return 'DeepSeek is rate limited. Try again later.'
  }
  if (code === 'provider_expert_busy') {
    return 'DeepSeek Expert is temporarily busy. Retry shortly.'
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
  if (code === 'account_queue_timeout') {
    return 'The DeepSeek account is busy. Try again shortly.'
  }
  if (code === 'account_usage_window_exhausted') {
    return 'DeepSeek account usage is cooling down. Retry after capacity recovers.'
  }
  if (code === 'background_capacity_reserved') {
    return 'Background capacity is paused to keep an account available for foreground requests.'
  }
  if (code === 'background_usage_capacity_reserved') {
    return 'Background capacity is paused to preserve rolling account capacity for foreground requests.'
  }
  if (code === 'provider_request_cancelled') {
    return 'The client closed the request.'
  }
  return 'DeepSeek is currently unavailable.'
}
