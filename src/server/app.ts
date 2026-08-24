import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import staticFiles from '@fastify/static'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import type { RuntimeConfig } from '../core/config.js'
import { requestForwarder } from '../main/proxy/forwarder.js'
import { storeManager } from '../main/store/store.js'
import { ConcurrencyGate } from './gateway/concurrency.js'
import { ProviderRoutingEngine } from './gateway/router.js'
import { registerAdminRoutes } from './routes/admin.js'
import { registerOpenAiRoutes } from './routes/openai.js'
import {
  checkProviderAccount,
  type AccountHealthChecker,
} from './providers/account-health.js'
import { accountHealthRegistry } from './providers/account-health-registry.js'
import { startAccountHealthMonitor } from './providers/account-health-monitor.js'
import { dispatchAlert } from './providers/alerts.js'
import { type AccountStateCounts, renderPrometheusMetrics } from './operations/metrics.js'
import { AdminAuth } from './security/admin-auth.js'

export interface AppDependencies {
  accountHealthChecker?: AccountHealthChecker
}

// Aggregate DeepSeek account states for the health and metrics surfaces. Returns
// counts only so neither surface can leak account identities or credentials.
function deepseekAccountCounts(): AccountStateCounts {
  const accounts = storeManager.getAccountsByProviderId('deepseek')
  const total = accounts.length
  const active = accounts.filter((account) => account.status === 'active').length
  const error = accounts.filter((account) => account.status === 'error').length
  return { total, active, error, inactive: total - active - error }
}

export async function buildApp(
  config: RuntimeConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: config.maxBodyBytes,
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: config.requestTimeoutMs + 5000,
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    logger: {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers.set-cookie',
          '*.token',
          '*.credentials',
          '*.password',
          '*.secret',
          '*.apiKey',
        ],
        censor: '[REDACTED]',
      },
      serializers: {
        req(request) {
          return {
            id: request.id,
            method: request.method,
            url: request.url,
          }
        },
      },
    },
  })

  storeManager.initialize({
    databasePath: config.databasePath,
    masterKey: config.masterKey,
  })
  storeManager.seedBootstrapApiKey(
    config.bootstrapApiKey,
    config.rateLimitRpm,
    config.dailyQuota,
  )
  requestForwarder.configure({
    requestTimeoutMs: config.requestTimeoutMs,
    sessionTtlMs: config.deepSeekSessionTtlMs,
  })

  await app.register(cookie)
  await app.register(rateLimit, {
    global: false,
    hook: 'preHandler',
    keyGenerator: (request) => request.ip,
  })
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (!origin) {
        callback(null, true)
        return
      }
      callback(null, config.adminOrigins.includes(origin))
    },
  })
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: config.nodeEnv === 'production'
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
  })
  app.addHook('onRequest', async (request, reply) => {
    if (
      config.adminHosts.length > 0
      && request.url.startsWith('/admin')
      && !config.adminHosts.includes(request.hostname.toLowerCase())
    ) {
      await reply.code(404).send({
        error: {
          code: 'not_found',
          message: 'Route not found.',
          requestId: request.id,
        },
      })
    }
  })

  const accountHealthChecker = dependencies.accountHealthChecker
    ?? ((provider, account) => checkProviderAccount(
      provider,
      account,
      undefined,
      config.masterKey,
    ))
  const routing = new ProviderRoutingEngine(config, undefined, storeManager, {
    getAccountIdentityFingerprint(accountId) {
      return accountHealthRegistry.get(accountId)?.identityFingerprint
    },
    onAccountSuspended(input) {
      accountHealthRegistry.record(input.accountId, {
        healthy: false,
        status: 'suspended',
        code: 'provider_account_suspended',
        message: input.message,
        checkedAt: Date.now(),
        latencyMs: input.latencyMs,
        ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
      })
      accountHealthMonitor.schedule(input.accountId, input.retryAt)
    },
  })
  const concurrency = new ConcurrencyGate(
    config.globalConcurrency,
    config.queueMaxDepth,
    config.queueTimeoutMs,
  )
  const adminAuth = new AdminAuth(config)

  const accountHealthMonitor = startAccountHealthMonitor({
    intervalMs: config.accountHealthIntervalMs,
    runImmediately: true,
    checker: accountHealthChecker,
    onHealthy(accountId) {
      routing.markAccountHealthy(accountId)
    },
    onUnhealthy(accountId, status, message) {
      // A DeepSeek web token is static and does not auto-refresh, so this is the
      // operator's cue to paste a fresh token via the admin console.
      app.log.error(
        { event: 'account_unhealthy', accountId, providerStatus: status, detail: message },
        'DeepSeek account unhealthy — the web token likely expired or was suspended; refresh it in the admin console',
      )
      void dispatchAlert(
        config.alertWebhookUrl,
        {
          event: 'account_unhealthy',
          provider: 'deepseek',
          accountId,
          status,
          message,
          timestamp: new Date().toISOString(),
        },
        app.log,
      )
    },
    onRecovered(accountId) {
      app.log.info({ event: 'account_recovered', accountId }, 'DeepSeek account recovered')
      void dispatchAlert(
        config.alertWebhookUrl,
        {
          event: 'account_recovered',
          provider: 'deepseek',
          accountId,
          timestamp: new Date().toISOString(),
        },
        app.log,
      )
    },
    onError(error) {
      app.log.warn({ errorType: error.name }, 'account health monitor failed')
    },
  })

  app.get('/', async (_request, reply) => reply.send({
    service: 'chat2api-web-gateway',
    status: 'ok',
    documentation: '/admin/',
  }))
  app.get('/health', async (_request, reply) => {
    try {
      storeManager.assertReady()
      return reply.send({ status: 'ok' })
    } catch {
      return reply.code(503).send({ status: 'unavailable' })
    }
  })
  app.get('/health/live', async (_request, reply) => reply.send({ status: 'alive' }))
  app.get('/health/ready', async (_request, reply) => {
    try {
      storeManager.assertReady()
      return reply.send({ status: 'ready' })
    } catch {
      return reply.code(503).send({ status: 'not_ready' })
    }
  })
  // Deep provider-account health for external monitoring/alerting. Intentionally
  // separate from /health/ready (the container liveness probe) so a dead upstream
  // token does not trigger a restart loop. Reports counts only — never account
  // names, emails, or credentials — so it is safe on an unauthenticated surface.
  app.get('/health/accounts', async (_request, reply) => {
    try {
      storeManager.assertReady()
    } catch {
      return reply.code(503).send({ status: 'not_ready' })
    }
    const counts = deepseekAccountCounts()
    const healthy = counts.active > 0
    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'no_healthy_account',
      provider: 'deepseek',
      total: counts.total,
      active: counts.active,
      error: counts.error,
      inactive: counts.inactive,
      healthy,
    })
  })
  // Prometheus scrape target. Aggregates only (no ids/names/credentials); like
  // /admin it should be restricted at the proxy layer on public deployments.
  app.get('/metrics', async (_request, reply) => {
    try {
      storeManager.assertReady()
    } catch {
      return reply.code(503).type('text/plain; charset=utf-8').send('# gateway not ready\n')
    }
    const body = renderPrometheusMetrics(storeManager.getOperationalMetrics(), deepseekAccountCounts())
    return reply.type('text/plain; version=0.0.4; charset=utf-8').send(body)
  })

  await registerOpenAiRoutes(app, routing, concurrency)
  await registerAdminRoutes(
    app,
    config,
    adminAuth,
    routing,
    concurrency,
    accountHealthChecker,
  )
  const webRoot = resolve(process.cwd(), 'dist/web')
  if (existsSync(webRoot)) {
    await app.register(staticFiles, {
      root: webRoot,
      prefix: '/admin/',
      index: ['index.html'],
      wildcard: false,
      setHeaders(response, filePath) {
        if (filePath.endsWith('index.html')) {
          response.header('Cache-Control', 'no-store')
        } else {
          response.header('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    })
    app.get('/admin', async (_request, reply) => reply.redirect('/admin/'))
    app.get('/admin/*', async (request, reply) => {
      if (request.url.startsWith('/admin/api/')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found.' } })
      }
      return reply.sendFile('index.html')
    })
  }

  app.setNotFoundHandler(async (request, reply) => {
    return reply.code(404).send({
      error: {
        code: 'not_found',
        message: 'Route not found.',
        requestId: request.id,
      },
    })
  })
  app.setErrorHandler(async (error, request, reply) => {
    const failure = error instanceof Error ? error : new Error('Unknown request failure')
    const statusCode = 'statusCode' in failure && typeof failure.statusCode === 'number'
      ? failure.statusCode
      : 500
    request.log.error({ requestId: request.id, errorType: failure.name }, 'request failed')
    if (reply.sent) return
    return reply.code(statusCode < 500 ? statusCode : 500).send({
      error: {
        code: statusCode === 413 ? 'payload_too_large' : 'internal_error',
        message: statusCode === 413
          ? 'Request body is too large.'
          : 'The gateway could not process the request.',
        requestId: request.id,
      },
    })
  })

  app.addHook('onClose', async () => {
    accountHealthMonitor.stop()
    accountHealthRegistry.clear()
    storeManager.flushPendingWrites()
    storeManager.close()
  })

  return app
}
