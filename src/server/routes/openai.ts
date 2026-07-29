import { pipeline } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { ZodError, z } from 'zod'
import type { ChatCompletionRequest, ProxyContext } from '../../main/proxy/types.js'
import { storeManager } from '../../main/store/store.js'
import { assertModelAllowed, requireApiScope } from '../security/api-auth.js'
import { parseChatRequest } from '../schemas/chat.js'
import { ConcurrencyGate } from '../gateway/concurrency.js'
import {
  ProviderRoutingEngine,
  isRoutingFailure,
  type RoutedResult,
} from '../gateway/router.js'

const completionSchema = z.object({
  model: z.string().min(1).max(256),
  prompt: z.union([z.string().max(200_000), z.array(z.string().max(200_000)).max(16)]),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().min(1).max(65_536).optional(),
  temperature: z.number().min(0).max(2).optional(),
})

const responseSchema = z.object({
  model: z.string().min(1).max(256),
  input: z.union([
    z.string().max(200_000),
    z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string().max(200_000),
    })).min(1).max(100),
  ]),
  stream: z.boolean().optional().default(false),
  max_output_tokens: z.number().int().min(1).max(65_536).optional(),
})

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

function contextFor(request: FastifyRequest, chat: ChatCompletionRequest): ProxyContext {
  return {
    requestId: request.id,
    model: chat.model,
    startTime: Date.now(),
    isStream: chat.stream === true,
  }
}

function extractText(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const choices = Reflect.get(body, 'choices')
  if (!Array.isArray(choices)) return ''
  const first = choices[0]
  if (!first || typeof first !== 'object') return ''
  const message = Reflect.get(first, 'message')
  if (!message || typeof message !== 'object') return ''
  const content = Reflect.get(message, 'content')
  return typeof content === 'string' ? content : ''
}

function extractFinishReason(body: unknown): string {
  if (!body || typeof body !== 'object') return 'stop'
  const choices = Reflect.get(body, 'choices')
  if (!Array.isArray(choices)) return 'stop'
  const first = choices[0]
  if (!first || typeof first !== 'object') return 'stop'
  const finishReason = Reflect.get(first, 'finish_reason')
  return typeof finishReason === 'string' ? finishReason : 'stop'
}

export async function registerOpenAiRoutes(
  app: FastifyInstance,
  routing: ProviderRoutingEngine,
  concurrency: ConcurrencyGate,
): Promise<void> {
  app.get('/v1/models', { preHandler: requireApiScope('models') }, async (_request, reply) => {
    const models = new Set<string>()
    for (const provider of storeManager.getProviders().filter((entry) => entry.enabled)) {
      if (storeManager.getAccountsByProviderId(provider.id).some((account) => account.status === 'active')) {
        for (const model of storeManager.getEffectiveModels(provider.id)) {
          models.add(model.displayName)
        }
      }
    }
    return reply.send({
      object: 'list',
      data: [...models].sort().map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'chat2api',
      })),
    })
  })

  app.post('/v1/chat/completions', { preHandler: requireApiScope('chat') }, async (request, reply) => {
    try {
      const chat = parseChatRequest(request.body)
      return await executeChat(request, reply, chat, routing, concurrency)
    } catch (error) {
      if (error instanceof ZodError) {
        return openAiError(reply, 400, 'The request body is invalid.', 'invalid_request', 'invalid_request_error')
      }
      request.log.warn({ requestId: request.id }, 'chat request validation failed')
      return openAiError(reply, 400, 'The request could not be accepted.', 'invalid_request', 'invalid_request_error')
    }
  })

  app.post('/v1/completions', { preHandler: requireApiScope('chat') }, async (request, reply) => {
    const parsed = completionSchema.safeParse(request.body)
    if (!parsed.success) {
      return openAiError(reply, 400, 'The request body is invalid.', 'invalid_request', 'invalid_request_error')
    }
    const prompt = Array.isArray(parsed.data.prompt) ? parsed.data.prompt.join('\n') : parsed.data.prompt
    const chat: ChatCompletionRequest = {
      model: parsed.data.model,
      messages: [{ role: 'user', content: prompt }],
      stream: parsed.data.stream,
      max_tokens: parsed.data.max_tokens,
      temperature: parsed.data.temperature,
    }
    if (chat.stream) {
      return openAiError(reply, 400, 'Streaming legacy completions are not supported.', 'unsupported_stream')
    }
    const result = await executeChat(request, reply, chat, routing, concurrency, false)
    if (reply.sent || !result || typeof result !== 'object') return result
    return reply.send({
      id: `cmpl_${randomUUID().replaceAll('-', '')}`,
      object: 'text_completion',
      created: Math.floor(Date.now() / 1000),
      model: chat.model,
      choices: [{
        text: extractText(result),
        index: 0,
        logprobs: null,
        finish_reason: extractFinishReason(result),
      }],
      usage: Reflect.get(result, 'usage') ?? null,
    })
  })

  app.post('/v1/responses', { preHandler: requireApiScope('chat') }, async (request, reply) => {
    const parsed = responseSchema.safeParse(request.body)
    if (!parsed.success) {
      return openAiError(reply, 400, 'The request body is invalid.', 'invalid_request', 'invalid_request_error')
    }
    if (parsed.data.stream) {
      return openAiError(reply, 400, 'Streaming Responses API is not enabled in this release.', 'unsupported_stream')
    }
    const messages = typeof parsed.data.input === 'string'
      ? [{ role: 'user' as const, content: parsed.data.input }]
      : parsed.data.input
    const chat: ChatCompletionRequest = {
      model: parsed.data.model,
      messages,
      stream: false,
      max_tokens: parsed.data.max_output_tokens,
    }
    const raw = await executeChat(request, reply, chat, routing, concurrency, false)
    if (reply.sent || !raw || typeof raw !== 'object') return raw
    const outputText = extractText(raw)
    const responseId = `resp_${randomUUID().replaceAll('-', '')}`
    return reply.send({
      id: responseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: chat.model,
      output: [{
        id: `msg_${randomUUID().replaceAll('-', '')}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: outputText, annotations: [] }],
      }],
      output_text: outputText,
      usage: Reflect.get(raw, 'usage') ?? null,
    })
  })
}

async function executeChat(
  request: FastifyRequest,
  reply: FastifyReply,
  chat: ChatCompletionRequest,
  routing: ProviderRoutingEngine,
  concurrency: ConcurrencyGate,
  sendReply = true,
): Promise<unknown> {
  if (!assertModelAllowed(request, chat.model)) {
    return openAiError(reply, 403, 'This API key cannot use the requested model.', 'model_not_allowed')
  }

  const releaseGlobal = concurrency.tryAcquire()
  if (!releaseGlobal) {
    return openAiError(reply, 503, 'The gateway is at capacity. Try again shortly.', 'gateway_at_capacity')
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

  try {
    const result = await routing.forward(chat, contextFor(request, chat))
    if (isRoutingFailure(result)) {
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
        result.status === 429 ? 'All matching providers are rate limited.' : 'No upstream provider is currently available.',
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

      request.raw.once('aborted', () => result.primed?.stream.destroy())
      pipeline(result.primed.stream, reply.raw, (error) => {
        const success = !error
        result.release(success)
        releaseGlobal()
        storeManager.finishRequestLog(requestLog.id, {
          status: success ? 'success' : 'error',
          statusCode: success ? 200 : 502,
          latency: Date.now() - startedAt,
          actualModel: result.selection.actualModel,
          providerId: result.selection.provider.id,
          accountId: result.selection.account.id,
          errorCode: success ? undefined : 'stream_interrupted',
        })
      })
      return undefined
    }

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
    return sendReply ? reply.send(result.result.body) : result.result.body
  } catch {
    routed?.release(false)
    releaseGlobal()
    storeManager.finishRequestLog(requestLog.id, {
      status: 'error',
      statusCode: 500,
      latency: Date.now() - startedAt,
      actualModel: routed?.selection.actualModel,
      providerId: routed?.selection.provider.id,
      accountId: routed?.selection.account.id,
      errorCode: 'gateway_error',
    })
    return openAiError(reply, 500, 'The gateway could not complete the request.', 'gateway_error')
  }
}
