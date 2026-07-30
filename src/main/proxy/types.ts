export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
}

export interface ProxyContext {
  requestId: string
  model: string
  startTime: number
  isStream: boolean
  signal?: AbortSignal
  providerId?: string
  accountId?: string
  actualModel?: string
}

export interface ForwardResult {
  success: boolean
  status?: number
  code?: string
  retryAfterMs?: number
  body?: unknown
  stream?: NodeJS.ReadableStream
  error?: string
  latency?: number
}

export interface AccountSelection {
  account: import('../store/types').Account
  provider: import('../store/types').Provider
  actualModel: string
}
