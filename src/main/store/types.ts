/**
 * Credential Storage Module - Type Definitions
 * Defines core data structures for accounts, providers, and configuration
 */

/**
 * Account Status Enum
 */
export type AccountStatus = 'active' | 'inactive' | 'expired' | 'error'

/**
 * Provider Type Enum
 */
export type ProviderType = 'builtin'

/**
 * Authentication Type Enum
 * - userToken: User Token authentication (DeepSeek)
 */
export type AuthType = 'userToken'

/**
 * Credential Field Configuration Interface
 * Defines credential fields required by provider
 */
export interface CredentialField {
  /** Field name */
  name: string
  /** Field label (display name) */
  label: string
  /** Field type */
  type: 'text' | 'password' | 'textarea'
  /** Whether required */
  required: boolean
  /** Placeholder text */
  placeholder?: string
  /** Help text */
  helpText?: string
}

/**
 * Built-in Provider Configuration Interface
 * Extends Provider interface, adds credential field configuration
 */
export interface BuiltinProviderConfig extends Omit<Provider, 'createdAt' | 'updatedAt'> {
  /** Credential field configuration */
  credentialFields: CredentialField[]
}

/**
 * Load Balance Strategy Enum
 */
export type LoadBalanceStrategy = 'round-robin' | 'least-used' | 'failover'

/**
 * Account Interface
 * Represents account configuration under a provider
 */
export interface Account {
  /** Account unique identifier */
  id: string
  /** Provider ID */
  providerId: string
  /** Account name */
  name: string
  /** Account email (optional) */
  email?: string
  /** Credential data (encrypted storage) */
  credentials: Record<string, string>
  /** Account status */
  status: AccountStatus
  /** Last used time (timestamp) */
  lastUsed?: number
  /** Created time (timestamp) */
  createdAt: number
  /** Updated time (timestamp) */
  updatedAt: number
  /** Error message (when status is error) */
  errorMessage?: string
  /** Request count */
  requestCount?: number
  /** Rolling account-usage limit. The legacy API name is retained for compatibility. */
  dailyLimit?: number
  /** Today used count */
  todayUsed?: number
  /** Attempts observed in the active account-usage window. */
  usageWindowUsed?: number
  /** Epoch time when the next usage slot becomes available. */
  usageWindowResetAt?: number
}

/**
 * Provider Interface
 * Represents an API provider configuration
 */
export interface Provider {
  /** Provider unique identifier */
  id: string
  /** Provider name */
  name: string
  /** Provider type */
  type: ProviderType
  /** Authentication type */
  authType: AuthType
  /** Whether enabled */
  enabled: boolean
  /** Created time (timestamp) */
  createdAt: number
  /** Updated time (timestamp) */
  updatedAt: number
  /** Provider description */
  description?: string
  /** Icon URL */
  icon?: string
  /** Supported model list */
  supportedModels?: string[]
}

/**
 * Application Configuration Interface
 */
export interface AppConfig {
  loadBalanceStrategy: LoadBalanceStrategy
  requestLogMaxEntries: number
}

/**
 * Daily Statistics Interface
 * Statistics for a single day
 */
export interface DailyStatistics {
  /** Date string (YYYY-MM-DD) */
  date: string
  /** Total requests */
  totalRequests: number
  /** Successful requests */
  successRequests: number
  /** Failed requests */
  failedRequests: number
  /** Total latency (for average calculation) */
  totalLatency: number
  /** Model usage count */
  modelUsage: Record<string, number>
  /** Provider usage count */
  providerUsage: Record<string, number>
}

/**
 * Persistent Statistics Interface
 * Statistics that persist across app restarts
 */
export interface PersistentStatistics {
  /** Total requests (all time) */
  totalRequests: number
  /** Successful requests (all time) */
  successRequests: number
  /** Failed requests (all time) */
  failedRequests: number
  /** Total latency for average calculation */
  totalLatency: number
  /** Last updated timestamp */
  lastUpdated: number
  /** Model usage count */
  modelUsage: Record<string, number>
  /** Provider usage count */
  providerUsage: Record<string, number>
  /** Account usage count */
  accountUsage: Record<string, number>
  /** Daily statistics (keyed by date string) */
  dailyStats: Record<string, DailyStatistics>
}

/**
 * Effective Model Information
 * Fixed model info exposed by the DeepSeek web adapter
 */
export interface EffectiveModel {
  /** Model display name (used in AI client) */
  displayName: string
  /** Actual model ID (used in API call) */
  actualModelId: string
}

/**
 * Default Persistent Statistics
 */
export const DEFAULT_STATISTICS: PersistentStatistics = {
  totalRequests: 0,
  successRequests: 0,
  failedRequests: 0,
  totalLatency: 0,
  lastUpdated: Date.now(),
  modelUsage: {},
  providerUsage: {},
  accountUsage: {},
  dailyStats: {},
}

/**
 * Default Application Configuration
 */
export const DEFAULT_CONFIG: AppConfig = {
  loadBalanceStrategy: 'least-used',
  requestLogMaxEntries: 200,
}

/**
 * Built-in Provider Configuration
 * Re-exported from providers/builtin/index.ts to avoid duplication
 */
export { builtinProviders as BUILTIN_PROVIDERS } from '../providers/builtin/index.ts'
