export interface ChatTextContentPart {
  type: 'text'
  text: string
}

export interface ChatImageContentPart {
  type: 'image_url'
  image_url: {
    url: string
  }
  filename?: string
}

export interface ChatFileContentPart {
  type: 'file'
  file: {
    filename: string
    file_data: string
  }
}

export type ChatContentPart =
  | ChatTextContentPart
  | ChatImageContentPart
  | ChatFileContentPart

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
  // OpenAI-compat fields the gateway honors best-effort. DeepSeek web ignores
  // these natively, so max_tokens/stop are applied by post-processing and
  // response_format (JSON mode) is emulated via an injected system instruction.
  max_tokens?: number
  stop?: string[]
  response_format?: { type?: string }
  // Tool/function-calling emulation: the requested tools are echoed here so the
  // non-stream response path can parse the model's tool envelope into tool_calls.
  tools?: Array<{ type?: string; function?: { name?: string; description?: string; parameters?: unknown } }>
  tool_choice?: unknown
}

export type RequestPriority = 'foreground' | 'background'

export interface ProxyContext {
  requestId: string
  model: string
  startTime: number
  isStream: boolean
  signal?: AbortSignal
  priority?: RequestPriority
  providerId?: string
  accountId?: string
  actualModel?: string
}

export interface ForwardStreamOutcome {
  success: boolean
  status: number
  code?: string
  retryAfterMs?: number
}

export interface ForwardResult {
  success: boolean
  status?: number
  code?: string
  retryAfterMs?: number
  body?: unknown
  stream?: NodeJS.ReadableStream
  streamOutcome?: Promise<ForwardStreamOutcome>
  error?: string
  latency?: number
}

export interface AccountSelection {
  account: import('../store/types').Account
  provider: import('../store/types').Provider
  actualModel: string
}
