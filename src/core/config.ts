import { Buffer } from 'node:buffer'
import { z } from 'zod'

const booleanValue = z.preprocess((value) => {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return value
  if (value.toLowerCase() === 'true') return true
  if (value.toLowerCase() === 'false') return false
  return value
}, z.boolean())

const trustProxyValue = z.preprocess((value) => {
  if (value === undefined || value === '') return 1
  if (value === false || value === 'false') return false
  if (typeof value === 'number') return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return value
}, z.union([
  z.literal(false),
  z.number().int().min(1).max(5),
]))

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  CHAT2API_HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  CHAT2API_DATABASE_PATH: z.string().min(1).default('/data/chat2api.sqlite'),
  CHAT2API_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug']).default('info'),
  CHAT2API_TRUST_PROXY: trustProxyValue,
  CHAT2API_SECURE_COOKIES: booleanValue.default(true),
  CHAT2API_MASTER_KEY: z.string().min(1),
  CHAT2API_BOOTSTRAP_API_KEY: z.string().min(32).max(512),
  CHAT2API_ADMIN_TOKEN: z.string().min(32).max(512),
  CHAT2API_SESSION_SECRET: z.string().min(32).max(512),
  CHAT2API_ADMIN_ORIGINS: z.string().min(1),
  CHAT2API_ADMIN_HOSTS: z.string().optional(),
  CHAT2API_MAX_BODY_BYTES: z.coerce.number().int().min(1024).max(10 * 1024 * 1024).default(2 * 1024 * 1024),
  CHAT2API_GLOBAL_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(20),
  CHAT2API_ACCOUNT_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(2),
  CHAT2API_RATE_LIMIT_RPM: z.coerce.number().int().min(1).max(100_000).default(60),
  CHAT2API_DAILY_QUOTA: z.coerce.number().int().min(1).max(10_000_000).default(1000),
  CHAT2API_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(15 * 60_000).default(120_000),
  CHAT2API_FIRST_BYTE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(5 * 60_000).default(30_000),
  CHAT2API_STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(5 * 60_000).default(90_000),
  CHAT2API_ACCOUNT_HEALTH_INTERVAL_MS: z.coerce.number().int().min(0).max(24 * 60 * 60_000).default(15 * 60_000),
})

export interface RuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production'
  host: string
  port: number
  databasePath: string
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug'
  trustProxy: false | number
  secureCookies: boolean
  masterKey: Buffer
  bootstrapApiKey: string
  adminToken: string
  sessionSecret: string
  adminOrigins: readonly string[]
  adminHosts: readonly string[]
  maxBodyBytes: number
  globalConcurrency: number
  accountConcurrency: number
  rateLimitRpm: number
  dailyQuota: number
  requestTimeoutMs: number
  firstByteTimeoutMs: number
  streamIdleTimeoutMs: number
  accountHealthIntervalMs: number
}

function parseMasterKey(value: string): Buffer {
  const encoded = value.startsWith('base64:') ? value.slice('base64:'.length) : value
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('CHAT2API_MASTER_KEY must be a base64-encoded 32-byte value')
  }

  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) {
    throw new Error('CHAT2API_MASTER_KEY must decode to exactly 32 bytes')
  }
  return key
}

function parseOrigins(value: string): readonly string[] {
  const origins = [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))]
  if (origins.length === 0) {
    throw new Error('CHAT2API_ADMIN_ORIGINS must contain at least one exact origin')
  }

  for (const origin of origins) {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Invalid exact admin origin: ${origin}`)
    }
  }
  return origins
}

function parseHosts(value: string | undefined): readonly string[] {
  if (!value?.trim()) return []
  const hosts = [...new Set(value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))]
  for (const host of hosts) {
    if (
      host.includes('/')
      || host.includes('@')
      || host.includes(':')
      || new URL(`https://${host}`).hostname !== host
    ) {
      throw new Error(`Invalid exact admin host: ${host}`)
    }
  }
  return hosts
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = environmentSchema.safeParse(environment)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`Invalid runtime configuration: ${issues}`)
  }

  const adminOrigins = parseOrigins(parsed.data.CHAT2API_ADMIN_ORIGINS)
  const adminHosts = parseHosts(parsed.data.CHAT2API_ADMIN_HOSTS)
  if (
    adminHosts.length > 0
    && adminOrigins.some((origin) => !adminHosts.includes(new URL(origin).hostname.toLowerCase()))
  ) {
    throw new Error('Every configured admin origin hostname must be present in CHAT2API_ADMIN_HOSTS')
  }

  return {
    nodeEnv: parsed.data.NODE_ENV,
    host: parsed.data.CHAT2API_HOST,
    port: parsed.data.PORT,
    databasePath: parsed.data.CHAT2API_DATABASE_PATH,
    logLevel: parsed.data.CHAT2API_LOG_LEVEL,
    trustProxy: parsed.data.CHAT2API_TRUST_PROXY,
    secureCookies: parsed.data.CHAT2API_SECURE_COOKIES,
    masterKey: parseMasterKey(parsed.data.CHAT2API_MASTER_KEY),
    bootstrapApiKey: parsed.data.CHAT2API_BOOTSTRAP_API_KEY,
    adminToken: parsed.data.CHAT2API_ADMIN_TOKEN,
    sessionSecret: parsed.data.CHAT2API_SESSION_SECRET,
    adminOrigins,
    adminHosts,
    maxBodyBytes: parsed.data.CHAT2API_MAX_BODY_BYTES,
    globalConcurrency: parsed.data.CHAT2API_GLOBAL_CONCURRENCY,
    accountConcurrency: parsed.data.CHAT2API_ACCOUNT_CONCURRENCY,
    rateLimitRpm: parsed.data.CHAT2API_RATE_LIMIT_RPM,
    dailyQuota: parsed.data.CHAT2API_DAILY_QUOTA,
    requestTimeoutMs: parsed.data.CHAT2API_REQUEST_TIMEOUT_MS,
    firstByteTimeoutMs: parsed.data.CHAT2API_FIRST_BYTE_TIMEOUT_MS,
    streamIdleTimeoutMs: parsed.data.CHAT2API_STREAM_IDLE_TIMEOUT_MS,
    accountHealthIntervalMs: parsed.data.CHAT2API_ACCOUNT_HEALTH_INTERVAL_MS,
  }
}
