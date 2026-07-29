import type { FastifyReply, FastifyRequest } from 'fastify'
import type { RuntimeConfig } from '../../core/config.js'
import { constantTimeEqual, randomToken, signValue } from '../../core/security/crypto.js'
import { registerSecret } from '../../core/security/redaction.js'

const SESSION_COOKIE = 'c2a_admin'
const CSRF_COOKIE = 'c2a_csrf'
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000

interface SessionPayload {
  nonce: string
  expiresAt: number
}

export class AdminAuth {
  constructor(private readonly config: RuntimeConfig) {
    registerSecret(config.adminToken)
    registerSecret(config.sessionSecret)
  }

  validateLoginToken(value: string): boolean {
    return constantTimeEqual(value, this.config.adminToken)
  }

  validateOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin
    return typeof origin === 'string' && this.config.adminOrigins.includes(origin)
  }

  issueSession(reply: FastifyReply): { csrfToken: string; expiresAt: number } {
    const payload: SessionPayload = {
      nonce: randomToken(18),
      expiresAt: Date.now() + SESSION_DURATION_MS,
    }
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signed = `${encoded}.${signValue(encoded, this.config.sessionSecret)}`
    const csrfToken = randomToken(24)

    reply.setCookie(SESSION_COOKIE, signed, this.cookieOptions(true, payload.expiresAt))
    reply.setCookie(CSRF_COOKIE, csrfToken, this.cookieOptions(false, payload.expiresAt))
    return { csrfToken, expiresAt: payload.expiresAt }
  }

  clearSession(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: '/admin' })
    reply.clearCookie(CSRF_COOKIE, { path: '/admin' })
  }

  requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = this.parseSession(request.cookies[SESSION_COOKIE])
    if (!session) {
      await reply.code(401).send({ error: { code: 'admin_auth_required', message: 'Authentication required.' } })
      return
    }
    request.adminSession = session
  }

  requireMutation = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await this.requireSession(request, reply)
    if (reply.sent) return

    const csrfHeader = request.headers['x-csrf-token']
    const csrfCookie = request.cookies[CSRF_COOKIE]
    if (
      !this.validateOrigin(request)
      || typeof csrfHeader !== 'string'
      || !csrfCookie
      || !constantTimeEqual(csrfHeader, csrfCookie)
    ) {
      await reply.code(403).send({ error: { code: 'csrf_validation_failed', message: 'Request validation failed.' } })
    }
  }

  private parseSession(value: string | undefined): SessionPayload | undefined {
    if (!value) return undefined
    const [encoded, signature, extra] = value.split('.')
    if (!encoded || !signature || extra !== undefined) return undefined
    if (!constantTimeEqual(signature, signValue(encoded, this.config.sessionSecret))) return undefined

    try {
      const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<SessionPayload>
      if (
        typeof payload.nonce !== 'string'
        || typeof payload.expiresAt !== 'number'
        || payload.expiresAt <= Date.now()
      ) {
        return undefined
      }
      return { nonce: payload.nonce, expiresAt: payload.expiresAt }
    } catch {
      return undefined
    }
  }

  private cookieOptions(httpOnly: boolean, expiresAt: number) {
    return {
      path: '/admin',
      httpOnly,
      secure: this.config.secureCookies,
      sameSite: 'strict' as const,
      expires: new Date(expiresAt),
    }
  }
}
