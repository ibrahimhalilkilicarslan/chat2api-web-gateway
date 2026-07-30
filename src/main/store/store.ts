import { randomUUID } from 'node:crypto'
import type BetterSqlite3 from 'better-sqlite3'
import { CredentialVault, constantTimeEqual, generateApiKey, hashSecret, secretPrefix } from '../../core/security/crypto.js'
import { redactText, registerSecret } from '../../core/security/redaction.js'
import {
  type DatabaseMaintenanceStatus,
  GatewayDatabase,
} from '../../core/storage/database.js'
import {
  type Account,
  type AppConfig,
  type DailyStatistics,
  type EffectiveModel,
  type PersistentStatistics,
  type Provider,
  BUILTIN_PROVIDERS,
  DEFAULT_CONFIG,
  DEFAULT_STATISTICS,
} from './types.js'

export interface StoreInitializationOptions {
  databasePath: string
  masterKey: Buffer
}

export type ApiScope = 'chat' | 'models'
export const ENVIRONMENT_API_KEY_ID = 'environment-bootstrap'

export interface StoredApiKey {
  id: string
  name: string
  keyHash: string
  keyPrefix: string
  scopes: ApiScope[]
  modelAllowlist: string[]
  requestsPerMinute: number
  dailyQuota: number
  enabled: boolean
  managedByEnvironment: boolean
  usageCount: number
  createdAt: number
  lastUsedAt?: number
  expiresAt?: number
  allowedCidrs: string[]
  rotatedFromId?: string
  replacedById?: string
}

export interface CreateApiKeyInput {
  name: string
  scopes: ApiScope[]
  modelAllowlist?: string[]
  requestsPerMinute: number
  dailyQuota: number
  expiresAt?: number
  allowedCidrs?: string[]
  rotatedFromId?: string
}

export interface CreatedApiKey {
  rawKey: string
  record: Omit<StoredApiKey, 'keyHash'>
}

export interface SafeRequestLog {
  id: string
  requestId: string
  timestamp: number
  completedAt?: number
  status: 'pending' | 'success' | 'error'
  statusCode: number
  method: string
  url: string
  model: string
  actualModel?: string
  providerId?: string
  accountId?: string
  apiKeyId?: string
  latency: number
  isStream: boolean
  errorCode?: string
}

export interface AuditLog {
  id: string
  timestamp: number
  actor: string
  action: string
  targetType?: string
  targetId?: string
  outcome: 'success' | 'failure'
  metadata: Record<string, string | number | boolean>
}

export interface OperationalMetrics {
  sampleSize: number
  latency: {
    average: number
    p50: number
    p95: number
    maximum: number
  }
  status: {
    success: number
    error: number
    pending: number
  }
  errorsByCode: Array<{ code: string; count: number }>
  usageByAccount: Array<{ accountId: string; count: number }>
  usageByModel: Array<{ model: string; count: number }>
  hourly: Array<{ hour: number; total: number; success: number; error: number }>
}

type ProviderRow = {
  id: string
  data_json: string
  created_at: number
  updated_at: number
}

type AccountRow = {
  id: string
  provider_id: string
  name: string
  email: string | null
  status: Account['status']
  encrypted_credentials: string
  last_used: number | null
  created_at: number
  updated_at: number
  error_message: string | null
  request_count: number
  daily_limit: number | null
  today_used: number
  usage_date: string
}

type ApiKeyRow = {
  id: string
  name: string
  key_hash: string
  key_prefix: string
  scopes_json: string
  model_allowlist_json: string
  requests_per_minute: number
  daily_quota: number
  enabled: number
  usage_count: number
  created_at: number
  last_used_at: number | null
  expires_at: number | null
  allowed_cidrs_json: string
  rotated_from_id: string | null
  replaced_by_id: string | null
}

type SettingRow = {
  value_json: string
}

type RequestLogRow = {
  id: string
  request_id: string
  timestamp: number
  completed_at: number | null
  status: SafeRequestLog['status']
  status_code: number
  method: string
  url: string
  model: string
  actual_model: string | null
  provider_id: string | null
  account_id: string | null
  api_key_id: string | null
  latency: number
  is_stream: number
  error_code: string | null
}

export class StoreManager {
  private database: GatewayDatabase | null = null
  private vault: CredentialVault | null = null
  private initializationError: Error | null = null

  initialize(options: StoreInitializationOptions): void {
    if (this.database) return

    try {
      this.database = new GatewayDatabase(options.databasePath)
      this.vault = new CredentialVault(options.masterKey)
      this.assertStoredCredentialsDecryptable()
      this.seedBuiltInProviders()
      this.ensureDefaultConfig()
      this.initializationError = null
    } catch (error) {
      this.database?.close()
      this.database = null
      this.vault = null
      this.initializationError = error instanceof Error ? error : new Error(String(error))
      throw this.initializationError
    }
  }

  close(): void {
    this.database?.close()
    this.database = null
    this.vault = null
  }

  assertReady(): void {
    this.requireDatabase().assertReady()
  }

  hasInitializationError(): boolean {
    return this.initializationError !== null
  }

  getInitializationError(): Error | null {
    return this.initializationError
  }

  flushPendingWrites(): void {
    this.requireDatabase().connection.pragma('wal_checkpoint(PASSIVE)')
  }

  generateId(): string {
    return randomUUID()
  }

  getProviders(): Provider[] {
    const rows = this.requireConnection()
      .prepare("SELECT * FROM providers WHERE id = 'deepseek' ORDER BY id")
      .all() as ProviderRow[]
    return rows.map((row) => this.providerFromRow(row))
  }

  getProviderById(id: string): Provider | undefined {
    if (!BUILTIN_PROVIDERS.some((provider) => provider.id === id)) return undefined
    const row = this.requireConnection()
      .prepare('SELECT * FROM providers WHERE id = ?')
      .get(id) as ProviderRow | undefined
    return row ? this.providerFromRow(row) : undefined
  }

  ensureProviderExists(providerId: string): void {
    if (this.getProviderById(providerId)) return
    const builtIn = BUILTIN_PROVIDERS.find((provider) => provider.id === providerId)
    if (!builtIn) throw new Error('Unknown built-in provider')
    this.insertProvider(this.toProvider(builtIn))
  }

  addProvider(provider: Provider): void {
    if (provider.type !== 'builtin' || !BUILTIN_PROVIDERS.some((candidate) => candidate.id === provider.id)) {
      throw new Error('Custom providers are disabled')
    }
    this.insertProvider(provider)
  }

  updateProvider(id: string, updates: Partial<Provider>): Provider | null {
    const current = this.getProviderById(id)
    if (!current) return null
    const builtIn = BUILTIN_PROVIDERS.find((provider) => provider.id === id)
    if (!builtIn) return null

    const next: Provider = {
      ...current,
      name: typeof updates.name === 'string' ? updates.name : current.name,
      enabled: true,
      supportedModels: builtIn.supportedModels,
      updatedAt: Date.now(),
    }
    this.requireConnection()
      .prepare('UPDATE providers SET data_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), next.updatedAt, id)
    return next
  }

  deleteProvider(_id: string): boolean {
    return false
  }

  getAccounts(includeCredentials = false): Account[] {
    this.resetDailyAccountUsage()
    const rows = this.requireConnection()
      .prepare("SELECT * FROM accounts WHERE provider_id = 'deepseek' ORDER BY created_at DESC")
      .all() as AccountRow[]
    return rows.map((row) => this.accountFromRow(row, includeCredentials))
  }

  getAccountById(id: string, includeCredentials = false): Account | undefined {
    this.resetDailyAccountUsage()
    const row = this.requireConnection()
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(id) as AccountRow | undefined
    if (row?.provider_id !== 'deepseek') return undefined
    return row ? this.accountFromRow(row, includeCredentials) : undefined
  }

  getAccountsByProviderId(providerId: string, includeCredentials = false): Account[] {
    if (providerId !== 'deepseek') return []
    this.resetDailyAccountUsage()
    const rows = this.requireConnection()
      .prepare('SELECT * FROM accounts WHERE provider_id = ? ORDER BY created_at')
      .all(providerId) as AccountRow[]
    return rows.map((row) => this.accountFromRow(row, includeCredentials))
  }

  getActiveAccounts(includeCredentials = false): Account[] {
    return this.getAccounts(includeCredentials).filter((account) => account.status === 'active')
  }

  addAccount(account: Account): void {
    this.ensureProviderExists(account.providerId)
    const encryptedCredentials = this.requireVault().encrypt(account.credentials)
    const usageDate = this.currentDate()
    this.requireConnection().prepare(`
      INSERT INTO accounts(
        id, provider_id, name, email, status, encrypted_credentials, last_used,
        created_at, updated_at, error_message, request_count, daily_limit,
        today_used, usage_date
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      account.id,
      account.providerId,
      account.name,
      account.email ?? null,
      account.status,
      encryptedCredentials,
      account.lastUsed ?? null,
      account.createdAt,
      account.updatedAt,
      account.errorMessage ?? null,
      account.requestCount ?? 0,
      account.dailyLimit ?? null,
      account.todayUsed ?? 0,
      usageDate,
    )
  }

  updateAccount(id: string, updates: Partial<Account>): Account | null {
    const current = this.getAccountById(id, true)
    if (!current) return null
    const hasCredentialUpdate = updates.credentials && Object.keys(updates.credentials).length > 0
    const credentials = hasCredentialUpdate
      ? { ...current.credentials, ...updates.credentials }
      : current.credentials
    const next: Account = {
      ...current,
      ...updates,
      credentials,
      id: current.id,
      providerId: current.providerId,
      updatedAt: Date.now(),
    }

    this.requireConnection().prepare(`
      UPDATE accounts
      SET name = ?, email = ?, status = ?, encrypted_credentials = ?, last_used = ?,
          updated_at = ?, error_message = ?, request_count = ?, daily_limit = ?,
          today_used = ?, usage_date = ?
      WHERE id = ?
    `).run(
      next.name,
      next.email ?? null,
      next.status,
      this.requireVault().encrypt(next.credentials),
      next.lastUsed ?? null,
      next.updatedAt,
      next.errorMessage ?? null,
      next.requestCount ?? 0,
      next.dailyLimit ?? null,
      next.todayUsed ?? 0,
      this.currentDate(),
      id,
    )
    return this.getAccountById(id, false) ?? null
  }

  deleteAccount(id: string): boolean {
    const result = this.requireConnection()
      .prepare("DELETE FROM accounts WHERE id = ? AND provider_id = 'deepseek'")
      .run(id)
    return result.changes > 0
  }

  getConfig(): AppConfig {
    const stored = this.getSetting<Partial<AppConfig>>('app_config') ?? {}
    return this.normalizeConfig(stored)
  }

  setConfig(config: AppConfig): void {
    this.setSetting('app_config', this.normalizeConfig(config))
  }

  updateConfig(updates: Partial<AppConfig>): AppConfig {
    const current = this.getConfig()
    const next = this.normalizeConfig({
      ...current,
      ...updates,
    })
    this.setSetting('app_config', next)
    return next
  }

  resetConfig(): AppConfig {
    const config = this.normalizeConfig(DEFAULT_CONFIG)
    this.setSetting('app_config', config)
    return config
  }

  getEffectiveModels(providerId: string): EffectiveModel[] {
    const provider = this.getProviderById(providerId)
    if (!provider) return []
    return (provider.supportedModels ?? [])
      .map((model) => ({
        displayName: model,
        actualModelId: model,
      }))
  }

  seedBootstrapApiKey(rawKey: string, requestsPerMinute: number, dailyQuota: number): void {
    const now = Date.now()
    this.requireConnection().transaction(() => {
      // v2 development builds used a random ID for this reserved record.
      this.requireConnection().prepare(`
        DELETE FROM api_keys
        WHERE name = 'Bootstrap key' AND id != ?
      `).run(ENVIRONMENT_API_KEY_ID)
      this.requireConnection().prepare(`
        INSERT INTO api_keys(
          id, name, key_hash, key_prefix, scopes_json, model_allowlist_json,
          requests_per_minute, daily_quota, enabled, usage_count, created_at,
          expires_at, allowed_cidrs_json, rotated_from_id, replaced_by_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, NULL, '[]', NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          key_hash = excluded.key_hash,
          key_prefix = excluded.key_prefix,
          scopes_json = excluded.scopes_json,
          model_allowlist_json = excluded.model_allowlist_json,
          requests_per_minute = excluded.requests_per_minute,
          daily_quota = excluded.daily_quota,
          enabled = 1,
          expires_at = NULL,
          allowed_cidrs_json = '[]',
          rotated_from_id = NULL,
          replaced_by_id = NULL
      `).run(
        ENVIRONMENT_API_KEY_ID,
        'Bootstrap key',
        hashSecret(rawKey),
        secretPrefix(rawKey),
        JSON.stringify(['chat', 'models']),
        JSON.stringify([]),
        requestsPerMinute,
        dailyQuota,
        now,
      )
    })()
  }

  createApiKey(input: CreateApiKeyInput): CreatedApiKey {
    const rawKey = generateApiKey()
    const now = Date.now()
    const record: StoredApiKey = {
      id: randomUUID(),
      name: input.name,
      keyHash: hashSecret(rawKey),
      keyPrefix: secretPrefix(rawKey),
      scopes: input.scopes,
      modelAllowlist: input.modelAllowlist ?? [],
      requestsPerMinute: input.requestsPerMinute,
      dailyQuota: input.dailyQuota,
      enabled: true,
      managedByEnvironment: false,
      usageCount: 0,
      createdAt: now,
      expiresAt: input.expiresAt,
      allowedCidrs: input.allowedCidrs ?? [],
      rotatedFromId: input.rotatedFromId,
    }
    this.insertApiKey(record)
    return {
      rawKey,
      record: this.publicApiKey(record),
    }
  }

  getApiKeys(): Array<Omit<StoredApiKey, 'keyHash'>> {
    const rows = this.requireConnection()
      .prepare('SELECT * FROM api_keys ORDER BY created_at DESC')
      .all() as ApiKeyRow[]
    return rows.map((row) => this.publicApiKey(this.apiKeyFromRow(row)))
  }

  findApiKey(rawKey: string): StoredApiKey | undefined {
    const digest = hashSecret(rawKey)
    const row = this.requireConnection()
      .prepare('SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1')
      .get(digest) as ApiKeyRow | undefined
    if (!row || !constantTimeEqual(digest, row.key_hash)) return undefined
    const record = this.apiKeyFromRow(row)
    if (record.expiresAt && record.expiresAt <= Date.now()) return undefined
    return record
  }

  getApiKeyById(id: string): StoredApiKey | undefined {
    const row = this.requireConnection()
      .prepare('SELECT * FROM api_keys WHERE id = ?')
      .get(id) as ApiKeyRow | undefined
    return row ? this.apiKeyFromRow(row) : undefined
  }

  getPublicApiKeyById(id: string): Omit<StoredApiKey, 'keyHash'> | undefined {
    const record = this.getApiKeyById(id)
    return record ? this.publicApiKey(record) : undefined
  }

  updateApiKey(
    id: string,
    updates: Partial<Pick<
      StoredApiKey,
      'enabled' | 'requestsPerMinute' | 'dailyQuota' | 'modelAllowlist' | 'expiresAt' | 'allowedCidrs'
    >>,
  ): boolean {
    if (id === ENVIRONMENT_API_KEY_ID) return false
    const current = this.getApiKeyById(id)
    if (!current) return false
    const next = {
      enabled: updates.enabled ?? current.enabled,
      requestsPerMinute: updates.requestsPerMinute ?? current.requestsPerMinute,
      dailyQuota: updates.dailyQuota ?? current.dailyQuota,
      modelAllowlist: updates.modelAllowlist ?? current.modelAllowlist,
      expiresAt: Object.hasOwn(updates, 'expiresAt') ? updates.expiresAt : current.expiresAt,
      allowedCidrs: updates.allowedCidrs ?? current.allowedCidrs,
    }
    return this.requireConnection().prepare(`
      UPDATE api_keys
      SET enabled = ?, requests_per_minute = ?, daily_quota = ?,
          model_allowlist_json = ?, expires_at = ?, allowed_cidrs_json = ?
      WHERE id = ?
    `).run(
      next.enabled ? 1 : 0,
      next.requestsPerMinute,
      next.dailyQuota,
      JSON.stringify(next.modelAllowlist),
      next.expiresAt ?? null,
      JSON.stringify(next.allowedCidrs),
      id,
    ).changes > 0
  }

  setApiKeyEnabled(id: string, enabled: boolean): boolean {
    return this.updateApiKey(id, { enabled })
  }

  rotateApiKey(
    id: string,
    gracePeriodMinutes: number,
    expiresAt?: number,
  ): CreatedApiKey | undefined {
    if (id === ENVIRONMENT_API_KEY_ID) return undefined
    const current = this.getApiKeyById(id)
    if (!current) return undefined

    return this.requireConnection().transaction(() => {
      const created = this.createApiKey({
        name: current.name,
        scopes: current.scopes,
        modelAllowlist: current.modelAllowlist,
        requestsPerMinute: current.requestsPerMinute,
        dailyQuota: current.dailyQuota,
        expiresAt,
        allowedCidrs: current.allowedCidrs,
        rotatedFromId: current.id,
      })
      const graceUntil = Date.now() + gracePeriodMinutes * 60_000
      const currentExpiry = current.expiresAt
        ? Math.min(current.expiresAt, graceUntil)
        : graceUntil
      this.requireConnection().prepare(`
        UPDATE api_keys
        SET expires_at = ?, replaced_by_id = ?
        WHERE id = ?
      `).run(currentExpiry, created.record.id, current.id)
      return created
    })()
  }

  deleteApiKey(id: string): boolean {
    if (id === ENVIRONMENT_API_KEY_ID) return false
    return this.requireConnection().prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0
  }

  consumeApiKeyDailyQuota(record: StoredApiKey): { allowed: boolean; used: number; limit: number } {
    const date = this.currentDate()
    return this.requireConnection().transaction(() => {
      const existing = this.requireConnection().prepare(`
        SELECT request_count FROM api_key_daily_usage WHERE api_key_id = ? AND usage_date = ?
      `).get(record.id, date) as { request_count: number } | undefined
      const used = existing?.request_count ?? 0
      if (used >= record.dailyQuota) {
        return { allowed: false, used, limit: record.dailyQuota }
      }

      this.requireConnection().prepare(`
        INSERT INTO api_key_daily_usage(api_key_id, usage_date, request_count)
        VALUES (?, ?, 1)
        ON CONFLICT(api_key_id, usage_date)
        DO UPDATE SET request_count = request_count + 1
      `).run(record.id, date)
      this.requireConnection().prepare(`
        UPDATE api_keys SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?
      `).run(Date.now(), record.id)
      this.requireConnection().prepare(`
        DELETE FROM api_key_daily_usage
        WHERE usage_date < date('now', '-90 days')
      `).run()
      return { allowed: true, used: used + 1, limit: record.dailyQuota }
    })()
  }

  startRequestLog(input: Omit<SafeRequestLog, 'id' | 'timestamp' | 'status' | 'statusCode' | 'latency'>): SafeRequestLog {
    const entry: SafeRequestLog = {
      ...input,
      id: randomUUID(),
      timestamp: Date.now(),
      status: 'pending',
      statusCode: 0,
      latency: 0,
    }
    this.requireConnection().prepare(`
      INSERT INTO request_logs(
        id, request_id, timestamp, status, status_code, method, url, model,
        actual_model, provider_id, account_id, api_key_id, latency, is_stream, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.requestId,
      entry.timestamp,
      entry.status,
      entry.statusCode,
      entry.method,
      entry.url,
      entry.model,
      entry.actualModel ?? null,
      entry.providerId ?? null,
      entry.accountId ?? null,
      entry.apiKeyId ?? null,
      entry.latency,
      entry.isStream ? 1 : 0,
      null,
    )
    const maxEntries = this.getConfig().requestLogMaxEntries
    this.requireConnection().prepare(`
      DELETE FROM request_logs
      WHERE id IN (
        SELECT id FROM request_logs
        ORDER BY timestamp DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(maxEntries)
    return entry
  }

  finishRequestLog(
    id: string,
    updates: Pick<SafeRequestLog, 'status' | 'statusCode' | 'latency'>
      & Partial<Pick<SafeRequestLog, 'actualModel' | 'providerId' | 'accountId' | 'errorCode'>>,
  ): boolean {
    const result = this.requireConnection().prepare(`
      UPDATE request_logs
      SET completed_at = ?, status = ?, status_code = ?, latency = ?, actual_model = ?,
          provider_id = COALESCE(?, provider_id),
          account_id = COALESCE(?, account_id),
          error_code = COALESCE(?, error_code)
      WHERE id = ?
    `).run(
      Date.now(),
      updates.status,
      updates.statusCode,
      updates.latency,
      updates.actualModel ?? null,
      updates.providerId ?? null,
      updates.accountId ?? null,
      updates.errorCode ?? null,
      id,
    )
    return result.changes > 0
  }

  listRequestLogs(limit = 100): SafeRequestLog[] {
    const safeLimit = Math.max(1, Math.min(500, limit))
    const rows = this.requireConnection()
      .prepare('SELECT * FROM request_logs ORDER BY timestamp DESC, rowid DESC LIMIT ?')
      .all(safeLimit) as RequestLogRow[]
    return rows.map((row) => this.requestLogFromRow(row))
  }

  addAuditLog(input: Omit<AuditLog, 'id' | 'timestamp'>): AuditLog {
    const entry: AuditLog = {
      ...input,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: this.sanitizeAuditMetadata(input.metadata),
    }
    this.requireConnection().prepare(`
      INSERT INTO audit_logs(
        id, timestamp, actor, action, target_type, target_id, outcome, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id,
      entry.timestamp,
      entry.actor,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.outcome,
      JSON.stringify(entry.metadata),
    )
    this.requireConnection().prepare(`
      DELETE FROM audit_logs
      WHERE id IN (
        SELECT id FROM audit_logs
        ORDER BY timestamp DESC
        LIMIT -1 OFFSET 2000
      )
    `).run()
    return entry
  }

  listAuditLogs(limit = 100): AuditLog[] {
    const rows = this.requireConnection().prepare(`
      SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT ?
    `).all(Math.max(1, Math.min(2000, limit))) as Array<{
      id: string
      timestamp: number
      actor: string
      action: string
      target_type: string | null
      target_id: string | null
      outcome: AuditLog['outcome']
      metadata_json: string
    }>
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type ?? undefined,
      targetId: row.target_id ?? undefined,
      outcome: row.outcome,
      metadata: JSON.parse(row.metadata_json) as AuditLog['metadata'],
    }))
  }

  getStatistics(): PersistentStatistics {
    const rows = this.listRequestLogs(500)
    const successful = rows.filter((entry) => entry.status === 'success')
    const failed = rows.filter((entry) => entry.status === 'error')
    const totalLatency = rows.reduce((sum, entry) => sum + entry.latency, 0)
    const modelUsage: Record<string, number> = {}
    const providerUsage: Record<string, number> = {}
    const accountUsage: Record<string, number> = {}
    for (const entry of rows) {
      modelUsage[entry.model] = (modelUsage[entry.model] ?? 0) + 1
      if (entry.providerId) providerUsage[entry.providerId] = (providerUsage[entry.providerId] ?? 0) + 1
      if (entry.accountId) accountUsage[entry.accountId] = (accountUsage[entry.accountId] ?? 0) + 1
    }
    return {
      ...DEFAULT_STATISTICS,
      totalRequests: rows.length,
      successRequests: successful.length,
      failedRequests: failed.length,
      totalLatency,
      lastUpdated: Date.now(),
      modelUsage,
      providerUsage,
      accountUsage,
      dailyStats: {},
    }
  }

  getTodayStatistics(): DailyStatistics {
    const todayStart = new Date(`${this.currentDate()}T00:00:00.000Z`).getTime()
    const rows = this.listRequestLogs(500).filter((entry) => entry.timestamp >= todayStart)
    return {
      date: this.currentDate(),
      totalRequests: rows.length,
      successRequests: rows.filter((entry) => entry.status === 'success').length,
      failedRequests: rows.filter((entry) => entry.status === 'error').length,
      totalLatency: rows.reduce((sum, entry) => sum + entry.latency, 0),
      modelUsage: {},
      providerUsage: {},
    }
  }

  getOperationalMetrics(limit = 500): OperationalMetrics {
    const rows = this.listRequestLogs(limit)
    const latencies = rows
      .filter((entry) => entry.status !== 'pending')
      .map((entry) => entry.latency)
      .sort((left, right) => left - right)
    const errors = new Map<string, number>()
    const accounts = new Map<string, number>()
    const models = new Map<string, number>()
    const hourly = new Map<number, { total: number; success: number; error: number }>()

    for (const entry of rows) {
      if (entry.errorCode) errors.set(entry.errorCode, (errors.get(entry.errorCode) ?? 0) + 1)
      if (entry.accountId) accounts.set(entry.accountId, (accounts.get(entry.accountId) ?? 0) + 1)
      models.set(entry.model, (models.get(entry.model) ?? 0) + 1)
      const hour = Math.floor(entry.timestamp / 3_600_000) * 3_600_000
      const bucket = hourly.get(hour) ?? { total: 0, success: 0, error: 0 }
      bucket.total += 1
      if (entry.status === 'success') bucket.success += 1
      if (entry.status === 'error') bucket.error += 1
      hourly.set(hour, bucket)
    }

    const sortedEntries = <T extends string>(
      source: Map<T, number>,
      key: 'code' | 'accountId' | 'model',
    ) => [...source.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 20)
      .map(([value, count]) => ({ [key]: value, count }))

    return {
      sampleSize: rows.length,
      latency: {
        average: latencies.length > 0
          ? Math.round(latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length)
          : 0,
        p50: this.percentile(latencies, 0.5),
        p95: this.percentile(latencies, 0.95),
        maximum: latencies.at(-1) ?? 0,
      },
      status: {
        success: rows.filter((entry) => entry.status === 'success').length,
        error: rows.filter((entry) => entry.status === 'error').length,
        pending: rows.filter((entry) => entry.status === 'pending').length,
      },
      errorsByCode: sortedEntries(errors, 'code') as OperationalMetrics['errorsByCode'],
      usageByAccount: sortedEntries(accounts, 'accountId') as OperationalMetrics['usageByAccount'],
      usageByModel: sortedEntries(models, 'model') as OperationalMetrics['usageByModel'],
      hourly: [...hourly.entries()]
        .sort((left, right) => left[0] - right[0])
        .slice(-24)
        .map(([hour, values]) => ({ hour, ...values })),
    }
  }

  getMaintenanceStatus(): DatabaseMaintenanceStatus {
    return this.requireDatabase().getMaintenanceStatus()
  }

  getStorePath(): string {
    return 'sqlite'
  }

  exportData(): {
    providers: Provider[]
    accounts: Array<Omit<Account, 'credentials'>>
    config: AppConfig
  } {
    return {
      providers: this.getProviders(),
      accounts: this.getAccounts(false).map(({ credentials: _credentials, ...account }) => account),
      config: this.getConfig(),
    }
  }

  clearAll(): void {
    throw new Error('Bulk data deletion is disabled')
  }

  private seedBuiltInProviders(): void {
    const existing = new Map(this.getProviders().map((provider) => [provider.id, provider]))
    for (const builtIn of BUILTIN_PROVIDERS) {
      const current = existing.get(builtIn.id)
      const provider = this.toProvider(builtIn, current)
      if (!current) {
        this.insertProvider(provider)
      } else {
        this.requireConnection()
          .prepare('UPDATE providers SET data_json = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(provider), provider.updatedAt, provider.id)
      }
    }
  }

  private toProvider(
    builtIn: (typeof BUILTIN_PROVIDERS)[number],
    existing?: Provider,
  ): Provider {
    const now = Date.now()
    return {
      id: builtIn.id,
      name: existing?.name ?? builtIn.name,
      type: 'builtin',
      authType: builtIn.authType,
      enabled: true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      description: builtIn.description,
      icon: builtIn.icon,
      supportedModels: builtIn.supportedModels,
    }
  }

  private insertProvider(provider: Provider): void {
    this.requireConnection().prepare(`
      INSERT INTO providers(id, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(provider.id, JSON.stringify(provider), provider.createdAt, provider.updatedAt)
  }

  private providerFromRow(row: ProviderRow): Provider {
    return JSON.parse(row.data_json) as Provider
  }

  private accountFromRow(row: AccountRow, includeCredentials: boolean): Account {
    const credentials = includeCredentials
      ? this.requireVault().decrypt<Record<string, string>>(row.encrypted_credentials)
      : {}
    if (includeCredentials) {
      for (const value of Object.values(credentials)) {
        if (typeof value === 'string') registerSecret(value)
      }
    }
    return {
      id: row.id,
      providerId: row.provider_id,
      name: row.name,
      email: row.email ?? undefined,
      credentials,
      status: row.status,
      lastUsed: row.last_used ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      errorMessage: row.error_message ?? undefined,
      requestCount: row.request_count,
      dailyLimit: row.daily_limit ?? undefined,
      todayUsed: row.today_used,
    }
  }

  private normalizeConfig(input: Partial<AppConfig>): AppConfig {
    const legacyInput = input as Record<string, unknown>
    const legacyRequestLogConfig = legacyInput.requestLogConfig
      && typeof legacyInput.requestLogConfig === 'object'
      ? legacyInput.requestLogConfig as Record<string, unknown>
      : undefined
    const rawStrategy = legacyInput.loadBalanceStrategy
    const rawRequestLogMaxEntries = legacyInput.requestLogMaxEntries
      ?? legacyRequestLogConfig?.maxEntries
    const loadBalanceStrategy: AppConfig['loadBalanceStrategy'] = rawStrategy === 'fill-first'
      ? 'least-used'
      : rawStrategy === 'round-robin' || rawStrategy === 'least-used' || rawStrategy === 'failover'
        ? rawStrategy
        : DEFAULT_CONFIG.loadBalanceStrategy
    return {
      loadBalanceStrategy,
      requestLogMaxEntries: typeof rawRequestLogMaxEntries === 'number'
        && Number.isInteger(rawRequestLogMaxEntries)
        && rawRequestLogMaxEntries >= 10
        && rawRequestLogMaxEntries <= 10_000
        ? rawRequestLogMaxEntries
        : DEFAULT_CONFIG.requestLogMaxEntries,
    }
  }

  private ensureDefaultConfig(): void {
    if (!this.getSetting('app_config')) {
      this.setSetting('app_config', this.normalizeConfig(DEFAULT_CONFIG))
    }
  }

  private getSetting<T>(key: string): T | undefined {
    const row = this.requireConnection()
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(key) as SettingRow | undefined
    return row ? JSON.parse(row.value_json) as T : undefined
  }

  private setSetting(key: string, value: unknown): void {
    this.requireConnection().prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now())
  }

  private insertApiKey(record: StoredApiKey): void {
    this.requireConnection().prepare(`
      INSERT INTO api_keys(
        id, name, key_hash, key_prefix, scopes_json, model_allowlist_json,
        requests_per_minute, daily_quota, enabled, usage_count, created_at, last_used_at,
        expires_at, allowed_cidrs_json, rotated_from_id, replaced_by_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.name,
      record.keyHash,
      record.keyPrefix,
      JSON.stringify(record.scopes),
      JSON.stringify(record.modelAllowlist),
      record.requestsPerMinute,
      record.dailyQuota,
      record.enabled ? 1 : 0,
      record.usageCount,
      record.createdAt,
      record.lastUsedAt ?? null,
      record.expiresAt ?? null,
      JSON.stringify(record.allowedCidrs),
      record.rotatedFromId ?? null,
      record.replacedById ?? null,
    )
  }

  private apiKeyFromRow(row: ApiKeyRow): StoredApiKey {
    return {
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      keyPrefix: row.key_prefix,
      scopes: JSON.parse(row.scopes_json) as ApiScope[],
      modelAllowlist: JSON.parse(row.model_allowlist_json) as string[],
      requestsPerMinute: row.requests_per_minute,
      dailyQuota: row.daily_quota,
      enabled: row.enabled === 1,
      managedByEnvironment: row.id === ENVIRONMENT_API_KEY_ID,
      usageCount: row.usage_count,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? undefined,
      expiresAt: row.expires_at ?? undefined,
      allowedCidrs: JSON.parse(row.allowed_cidrs_json) as string[],
      rotatedFromId: row.rotated_from_id ?? undefined,
      replacedById: row.replaced_by_id ?? undefined,
    }
  }

  private publicApiKey(record: StoredApiKey): Omit<StoredApiKey, 'keyHash'> {
    const { keyHash: _keyHash, ...publicRecord } = record
    return publicRecord
  }

  private requestLogFromRow(row: RequestLogRow): SafeRequestLog {
    return {
      id: row.id,
      requestId: row.request_id,
      timestamp: row.timestamp,
      completedAt: row.completed_at ?? undefined,
      status: row.status,
      statusCode: row.status_code,
      method: row.method,
      url: row.url,
      model: row.model,
      actualModel: row.actual_model ?? undefined,
      providerId: row.provider_id ?? undefined,
      accountId: row.account_id ?? undefined,
      apiKeyId: row.api_key_id ?? undefined,
      latency: row.latency,
      isStream: row.is_stream === 1,
      errorCode: row.error_code ?? undefined,
    }
  }

  private sanitizeAuditMetadata(
    metadata: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> {
    const allowed: Record<string, string | number | boolean> = {}
    for (const [key, value] of Object.entries(metadata)) {
      if (!/^(requestId|providerId|accountId|apiKeyId|enabled|count|status|model|healthCode)$/.test(key)) continue
      allowed[key] = typeof value === 'string' ? redactText(value).slice(0, 200) : value
    }
    return allowed
  }

  private resetDailyAccountUsage(): void {
    const today = this.currentDate()
    this.requireConnection()
      .prepare('UPDATE accounts SET today_used = 0, usage_date = ? WHERE usage_date != ?')
      .run(today, today)
  }

  private currentDate(): string {
    return new Date().toISOString().slice(0, 10)
  }

  private percentile(values: number[], percentile: number): number {
    if (values.length === 0) return 0
    const index = Math.min(values.length - 1, Math.ceil(values.length * percentile) - 1)
    return values[index] ?? 0
  }

  private assertStoredCredentialsDecryptable(): void {
    const rows = this.requireConnection()
      .prepare('SELECT encrypted_credentials FROM accounts')
      .all() as Array<{ encrypted_credentials: string }>
    try {
      for (const row of rows) this.requireVault().decrypt(row.encrypted_credentials)
    } catch {
      throw new Error('Stored provider credentials cannot be decrypted with the configured master key')
    }
  }

  private requireDatabase(): GatewayDatabase {
    if (!this.database) {
      throw this.initializationError ?? new Error('Store is not initialized')
    }
    return this.database
  }

  private requireConnection(): BetterSqlite3.Database {
    return this.requireDatabase().connection
  }

  private requireVault(): CredentialVault {
    if (!this.vault) throw new Error('Credential vault is not initialized')
    return this.vault
  }
}

export const storeManager = new StoreManager()
export default storeManager
