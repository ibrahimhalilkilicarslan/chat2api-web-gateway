import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ApiScope } from '../../main/store/store.js'
import { storeManager } from '../../main/store/store.js'
import { isIpAllowed } from './ip-allowlist.js'
import { SlidingWindowRateLimiter } from './rate-limiter.js'

const limiter = new SlidingWindowRateLimiter()

function unauthorized(reply: FastifyReply): void {
  void reply.code(401).send({
    error: {
      message: 'Invalid or missing API credentials.',
      type: 'authentication_error',
      code: 'invalid_api_key',
    },
  })
}

function readBearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization
  if (!authorization) return undefined
  const match = /^Bearer ([^\s]+)$/.exec(authorization)
  return match?.[1]
}

export function requireApiScope(scope: ApiScope) {
  return async function apiKeyGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const rawKey = readBearerToken(request)
    if (!rawKey) {
      unauthorized(reply)
      return
    }

    const record = storeManager.findApiKey(rawKey)
    if (
      !record
      || !record.scopes.includes(scope)
      || !isIpAllowed(request.ip, record.allowedCidrs)
    ) {
      unauthorized(reply)
      return
    }

    const minute = limiter.consume(record)
    reply.header('X-RateLimit-Limit', minute.limit)
    reply.header('X-RateLimit-Remaining', minute.remaining)
    reply.header('X-RateLimit-Reset', Math.ceil(minute.resetAt / 1000))
    if (!minute.allowed) {
      reply.header('Retry-After', Math.max(1, Math.ceil((minute.resetAt - Date.now()) / 1000)))
      await reply.code(429).send({
        error: {
          message: 'Rate limit exceeded.',
          type: 'rate_limit_error',
          code: 'rate_limit_exceeded',
        },
      })
      return
    }

    const daily = storeManager.consumeApiKeyDailyQuota(record)
    reply.header('X-DailyLimit-Limit', daily.limit)
    reply.header('X-DailyLimit-Remaining', Math.max(0, daily.limit - daily.used))
    if (!daily.allowed) {
      await reply.code(429).send({
        error: {
          message: 'Daily quota exceeded.',
          type: 'rate_limit_error',
          code: 'daily_quota_exceeded',
        },
      })
      return
    }

    request.apiKey = record
  }
}

export function assertModelAllowed(request: FastifyRequest, model: string): boolean {
  const allowlist = request.apiKey?.modelAllowlist ?? []
  return allowlist.length === 0 || allowlist.includes(model)
}
