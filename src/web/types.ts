export interface Overview {
  providers: { total: number; enabled: number }
  accounts: { total: number; active: number; attention: number }
  requests: { total: number; today: number; successRate: number; averageLatency: number }
  gateway: {
    active: number
    limit: number
    accountConcurrency: Array<{ accountId: string; active: number }>
    openCircuits: Array<{ accountId: string; openedUntil: number }>
  }
}

export interface CredentialField {
  name: string
  label: string
  type: 'text' | 'password' | 'textarea'
  required: boolean
  placeholder?: string
  helpText?: string
}

export interface Provider {
  id: string
  name: string
  enabled: boolean
  description?: string
  supportedModels: string[]
  credentialFields: CredentialField[]
  accountCount: number
  activeAccountCount: number
}

export interface Account {
  id: string
  providerId: string
  name: string
  email?: string
  status: 'active' | 'inactive' | 'expired' | 'error'
  credentialConfigured: boolean
  lastUsed?: number
  createdAt: number
  updatedAt: number
  errorMessage?: string
  requestCount: number
  dailyLimit?: number
  todayUsed: number
}

export interface ApiKeyRecord {
  id: string
  name: string
  keyPrefix: string
  scopes: Array<'chat' | 'models'>
  modelAllowlist: string[]
  requestsPerMinute: number
  dailyQuota: number
  enabled: boolean
  managedByEnvironment: boolean
  usageCount: number
  createdAt: number
  lastUsedAt?: number
}

export interface RequestActivity {
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
  latency: number
  isStream: boolean
  errorCode?: string
}

export interface GatewaySettings {
  loadBalanceStrategy: 'round-robin' | 'fill-first' | 'failover'
  requestTimeout: number
  sessionTimeout: number
  deleteAfterTimeout: boolean
  security: {
    credentialEncryption: string
    apiKeyStorage: string
    requestBodiesLogged: boolean
    customProvidersEnabled: boolean
    remoteMediaEnabled: boolean
    secureCookies: boolean
  }
}

export interface DashboardData {
  overview: Overview
  providers: Provider[]
  accounts: Account[]
  apiKeys: ApiKeyRecord[]
  activity: RequestActivity[]
  settings: GatewaySettings
}
