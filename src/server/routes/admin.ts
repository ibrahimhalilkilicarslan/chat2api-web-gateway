import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RuntimeConfig } from '../../core/config.js'
import { registerSecret } from '../../core/security/redaction.js'
import { BUILTIN_PROVIDERS, type Account } from '../../main/store/types.js'
import { storeManager, type ApiScope } from '../../main/store/store.js'
import type { ConcurrencyGate } from '../gateway/concurrency.js'
import type { ProviderRoutingEngine } from '../gateway/router.js'
import type { AdminAuth } from '../security/admin-auth.js'

const loginSchema = z.object({
  token: z.string().min(1).max(512),
})

const providerUpdateSchema = z.object({
  enabled: z.boolean(),
})

const accountCreateSchema = z.object({
  providerId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
  credentials: z.record(z.string(), z.string().min(1).max(200_000)),
  dailyLimit: z.number().int().min(1).max(1_000_000).optional(),
})

const accountUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().max(254).optional().or(z.literal('')),
  status: z.enum(['active', 'inactive']).optional(),
  credentials: z.record(z.string(), z.string().min(1).max(200_000)).optional(),
  dailyLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
})

const apiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120).refine(
    (value) => value.toLowerCase() !== 'bootstrap key',
    'This API key name is reserved.',
  ),
  scopes: z.array(z.enum(['chat', 'models'])).min(1).max(2),
  modelAllowlist: z.array(z.string().min(1).max(256)).max(200).default([]),
  requestsPerMinute: z.number().int().min(1).max(100_000),
  dailyQuota: z.number().int().min(1).max(10_000_000),
})

const apiKeyUpdateSchema = z.object({
  enabled: z.boolean(),
})

const settingsSchema = z.object({
  loadBalanceStrategy: z.enum(['round-robin', 'fill-first', 'failover']).optional(),
  requestTimeout: z.number().int().min(1000).max(15 * 60_000).optional(),
  sessionTimeout: z.number().int().min(1).max(24 * 60).optional(),
  deleteAfterTimeout: z.boolean().optional(),
})

function safeAccount(account: Account) {
  return {
    id: account.id,
    providerId: account.providerId,
    name: account.name,
    email: account.email,
    status: account.status,
    credentialConfigured: true,
    lastUsed: account.lastUsed,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    errorMessage: account.errorMessage,
    requestCount: account.requestCount ?? 0,
    dailyLimit: account.dailyLimit,
    todayUsed: account.todayUsed ?? 0,
  }
}

function validateCredentialFields(
  providerId: string,
  credentials: Record<string, string>,
  partial: boolean,
): string | undefined {
  const provider = BUILTIN_PROVIDERS.find((entry) => entry.id === providerId)
  if (!provider) return 'Unknown provider.'
  const allowed = new Set(provider.credentialFields.map((field) => field.name))
  if (Object.keys(credentials).some((key) => !allowed.has(key))) {
    return 'Credential payload contains an unsupported field.'
  }
  if (!partial) {
    const missing = provider.credentialFields
      .filter((field) => field.required)
      .some((field) => !credentials[field.name]?.trim())
    if (missing) return 'Required provider credentials are missing.'
  }
  return undefined
}

export async function registerAdminRoutes(
  app: FastifyInstance,
  config: RuntimeConfig,
  adminAuth: AdminAuth,
  routing: ProviderRoutingEngine,
  concurrency: ConcurrencyGate,
): Promise<void> {
  app.post('/admin/api/login', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
      },
    },
  }, async (request, reply) => {
    if (!adminAuth.validateOrigin(request)) {
      return reply.code(403).send({ error: { code: 'origin_not_allowed', message: 'Request origin is not allowed.' } })
    }
    const parsed = loginSchema.safeParse(request.body)
    if (!parsed.success || !adminAuth.validateLoginToken(parsed.data.token)) {
      storeManager.addAuditLog({
        actor: 'anonymous',
        action: 'admin.login',
        outcome: 'failure',
        metadata: {},
      })
      return reply.code(401).send({ error: { code: 'invalid_credentials', message: 'Invalid credentials.' } })
    }

    const session = adminAuth.issueSession(reply)
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'admin.login',
      outcome: 'success',
      metadata: {},
    })
    return reply.send({ authenticated: true, ...session })
  })

  app.get('/admin/api/session', { preHandler: adminAuth.requireSession }, async (request, reply) => {
    return reply.send({
      authenticated: true,
      expiresAt: request.adminSession?.expiresAt,
      csrfToken: request.cookies.c2a_csrf,
    })
  })

  app.post('/admin/api/logout', { preHandler: adminAuth.requireMutation }, async (_request, reply) => {
    adminAuth.clearSession(reply)
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'admin.logout',
      outcome: 'success',
      metadata: {},
    })
    return reply.send({ authenticated: false })
  })

  app.get('/admin/api/overview', { preHandler: adminAuth.requireSession }, async (_request, reply) => {
    const accounts = storeManager.getAccounts()
    const providers = storeManager.getProviders()
    const statistics = storeManager.getStatistics()
    const today = storeManager.getTodayStatistics()
    const successRate = statistics.totalRequests > 0
      ? statistics.successRequests / statistics.totalRequests
      : 1
    return reply.send({
      providers: {
        total: providers.length,
        enabled: providers.filter((provider) => provider.enabled).length,
      },
      accounts: {
        total: accounts.length,
        active: accounts.filter((account) => account.status === 'active').length,
        attention: accounts.filter((account) => account.status === 'error' || account.status === 'expired').length,
      },
      requests: {
        total: statistics.totalRequests,
        today: today.totalRequests,
        successRate,
        averageLatency: statistics.totalRequests > 0
          ? Math.round(statistics.totalLatency / statistics.totalRequests)
          : 0,
      },
      gateway: {
        active: concurrency.getActive(),
        limit: concurrency.getLimit(),
        ...routing.getState(),
      },
    })
  })

  app.get('/admin/api/providers', { preHandler: adminAuth.requireSession }, async (_request, reply) => {
    const stored = new Map(storeManager.getProviders().map((provider) => [provider.id, provider]))
    return reply.send(BUILTIN_PROVIDERS.map((provider) => ({
      id: provider.id,
      name: stored.get(provider.id)?.name ?? provider.name,
      enabled: stored.get(provider.id)?.enabled ?? false,
      description: provider.description,
      supportedModels: storeManager.getEffectiveModels(provider.id).map((model) => model.displayName),
      credentialFields: provider.credentialFields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        placeholder: field.placeholder,
        helpText: field.helpText,
      })),
      accountCount: storeManager.getAccountsByProviderId(provider.id).length,
      activeAccountCount: storeManager
        .getAccountsByProviderId(provider.id)
        .filter((account) => account.status === 'active').length,
    })))
  })

  app.patch('/admin/api/providers/:id', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const id = z.string().min(1).max(64).safeParse((request.params as { id?: unknown }).id)
    const body = providerUpdateSchema.safeParse(request.body)
    if (!id.success || !body.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid provider update.' } })
    }
    const provider = storeManager.updateProvider(id.data, { enabled: body.data.enabled })
    if (!provider) return reply.code(404).send({ error: { code: 'not_found', message: 'Provider not found.' } })
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'provider.update',
      targetType: 'provider',
      targetId: id.data,
      outcome: 'success',
      metadata: { enabled: body.data.enabled },
    })
    return reply.send({ id: provider.id, enabled: provider.enabled })
  })

  app.get('/admin/api/accounts', { preHandler: adminAuth.requireSession }, async (_request, reply) => {
    return reply.send(storeManager.getAccounts(false).map(safeAccount))
  })

  app.post('/admin/api/accounts', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const parsed = accountCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid account details.' } })
    }
    const credentialError = validateCredentialFields(parsed.data.providerId, parsed.data.credentials, false)
    if (credentialError) {
      return reply.code(400).send({ error: { code: 'invalid_credentials', message: credentialError } })
    }
    for (const value of Object.values(parsed.data.credentials)) registerSecret(value)

    const now = Date.now()
    const account: Account = {
      id: storeManager.generateId(),
      providerId: parsed.data.providerId,
      name: parsed.data.name,
      email: parsed.data.email || undefined,
      credentials: parsed.data.credentials,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      requestCount: 0,
      dailyLimit: parsed.data.dailyLimit,
      todayUsed: 0,
    }
    storeManager.addAccount(account)
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'account.create',
      targetType: 'account',
      targetId: account.id,
      outcome: 'success',
      metadata: { providerId: account.providerId },
    })
    return reply.code(201).send(safeAccount(account))
  })

  app.patch('/admin/api/accounts/:id', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id)
    const body = accountUpdateSchema.safeParse(request.body)
    if (!id.success || !body.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid account update.' } })
    }
    const current = storeManager.getAccountById(id.data)
    if (!current) return reply.code(404).send({ error: { code: 'not_found', message: 'Account not found.' } })
    if (body.data.credentials) {
      const credentialError = validateCredentialFields(current.providerId, body.data.credentials, true)
      if (credentialError) {
        return reply.code(400).send({ error: { code: 'invalid_credentials', message: credentialError } })
      }
      for (const value of Object.values(body.data.credentials)) registerSecret(value)
    }
    const updated = storeManager.updateAccount(id.data, {
      ...body.data,
      email: body.data.email || undefined,
      dailyLimit: body.data.dailyLimit ?? undefined,
    })
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'account.update',
      targetType: 'account',
      targetId: id.data,
      outcome: 'success',
      metadata: { providerId: current.providerId },
    })
    return reply.send(updated ? safeAccount(updated) : null)
  })

  app.delete('/admin/api/accounts/:id', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id)
    if (!id.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid account ID.' } })
    }
    const deleted = storeManager.deleteAccount(id.data)
    if (!deleted) return reply.code(404).send({ error: { code: 'not_found', message: 'Account not found.' } })
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'account.delete',
      targetType: 'account',
      targetId: id.data,
      outcome: 'success',
      metadata: {},
    })
    return reply.code(204).send()
  })

  app.get('/admin/api/api-keys', { preHandler: adminAuth.requireSession }, async (_request, reply) => {
    return reply.send(storeManager.getApiKeys())
  })

  app.post('/admin/api/api-keys', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const parsed = apiKeyCreateSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid API key policy.' } })
    }
    const created = storeManager.createApiKey({
      ...parsed.data,
      scopes: parsed.data.scopes as ApiScope[],
    })
    registerSecret(created.rawKey)
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'api_key.create',
      targetType: 'api_key',
      targetId: created.record.id,
      outcome: 'success',
      metadata: {},
    })
    return reply.code(201).send(created)
  })

  app.patch('/admin/api/api-keys/:id', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id)
    const body = apiKeyUpdateSchema.safeParse(request.body)
    if (!id.success || !body.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid API key update.' } })
    }
    if (!storeManager.setApiKeyEnabled(id.data, body.data.enabled)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'API key not found.' } })
    }
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'api_key.update',
      targetType: 'api_key',
      targetId: id.data,
      outcome: 'success',
      metadata: { enabled: body.data.enabled },
    })
    return reply.send({ id: id.data, enabled: body.data.enabled })
  })

  app.delete('/admin/api/api-keys/:id', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const id = z.string().uuid().safeParse((request.params as { id?: unknown }).id)
    if (!id.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid API key ID.' } })
    }
    if (!storeManager.deleteApiKey(id.data)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'API key not found.' } })
    }
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'api_key.delete',
      targetType: 'api_key',
      targetId: id.data,
      outcome: 'success',
      metadata: {},
    })
    return reply.code(204).send()
  })

  app.get('/admin/api/activity', { preHandler: adminAuth.requireSession }, async (request, reply) => {
    const limit = z.coerce.number().int().min(1).max(500).catch(100).parse(
      (request.query as { limit?: unknown }).limit,
    )
    return reply.send(storeManager.listRequestLogs(limit))
  })

  app.get('/admin/api/audit', { preHandler: adminAuth.requireSession }, async (request, reply) => {
    const limit = z.coerce.number().int().min(1).max(500).catch(100).parse(
      (request.query as { limit?: unknown }).limit,
    )
    return reply.send(storeManager.listAuditLogs(limit))
  })

  app.get('/admin/api/settings', { preHandler: adminAuth.requireSession }, async (_request, reply) => {
    const current = storeManager.getConfig()
    return reply.send({
      loadBalanceStrategy: current.loadBalanceStrategy,
      requestTimeout: current.requestTimeout,
      sessionTimeout: current.sessionConfig.sessionTimeout,
      deleteAfterTimeout: current.sessionConfig.deleteAfterTimeout,
      security: {
        credentialEncryption: 'AES-256-GCM',
        apiKeyStorage: 'SHA-256',
        requestBodiesLogged: false,
        customProvidersEnabled: false,
        remoteMediaEnabled: false,
        secureCookies: config.secureCookies,
      },
    })
  })

  app.patch('/admin/api/settings', { preHandler: adminAuth.requireMutation }, async (request, reply) => {
    const parsed = settingsSchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'invalid_request', message: 'Invalid gateway settings.' } })
    }
    const current = storeManager.getConfig()
    const updated = storeManager.updateConfig({
      loadBalanceStrategy: parsed.data.loadBalanceStrategy ?? current.loadBalanceStrategy,
      requestTimeout: parsed.data.requestTimeout ?? current.requestTimeout,
      sessionConfig: {
        ...current.sessionConfig,
        sessionTimeout: parsed.data.sessionTimeout ?? current.sessionConfig.sessionTimeout,
        deleteAfterTimeout: parsed.data.deleteAfterTimeout ?? current.sessionConfig.deleteAfterTimeout,
      },
    })
    storeManager.addAuditLog({
      actor: 'admin',
      action: 'gateway.settings.update',
      outcome: 'success',
      metadata: {},
    })
    return reply.send({
      loadBalanceStrategy: updated.loadBalanceStrategy,
      requestTimeout: updated.requestTimeout,
      sessionTimeout: updated.sessionConfig.sessionTimeout,
      deleteAfterTimeout: updated.sessionConfig.deleteAfterTimeout,
    })
  })
}
