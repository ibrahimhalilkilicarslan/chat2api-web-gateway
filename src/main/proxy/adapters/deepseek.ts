import { createHash, randomBytes, randomUUID } from 'node:crypto'
import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios'
import { getDeepSeekHash } from '../../lib/challenge'
import type { Account, Provider } from '../../store/types'
import type { ChatMessage } from '../types'
import { resolveDeepSeekChatOptions } from './providerModelOptions'

const DEEPSEEK_API_BASE = 'https://chat.deepseek.com/api'
const SESSION_CREATE_PATH = '/v0/chat_session/create'
const SESSION_DELETE_PATH = '/v0/chat_session/delete'
const CHAT_COMPLETION_PATH = '/v0/chat/completion'
const CHALLENGE_PATH = '/v0/chat/create_pow_challenge'

const WEB_HEADERS = {
  Accept: '*/*',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Origin: 'https://chat.deepseek.com',
  Referer: 'https://chat.deepseek.com/',
  'Sec-Ch-Ua': '"Not/A)Brand";v="99", "Chromium";v="148"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'empty',
  'Sec-Fetch-Mode': 'cors',
  'Sec-Fetch-Site': 'same-origin',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  'X-App-Version': '2.0.0',
  'X-Client-Locale': 'zh_CN',
  'X-Client-Platform': 'web',
  'X-Client-Version': '2.0.0',
}

interface DeepSeekHttpClient {
  get<T = unknown>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>
  post<T = unknown>(url: string, data?: unknown, config?: AxiosRequestConfig): Promise<AxiosResponse<T>>
}

interface TokenInfo {
  accessToken: string
  expiresAt: number
}

interface ChallengeResponse {
  algorithm: string
  challenge: string
  salt: string
  difficulty: number
  expire_at: number
  signature: string
}

interface ChatCompletionInput {
  model: string
  messages: ChatMessage[]
  web_search?: boolean
  reasoning_effort?: 'low' | 'medium' | 'high'
}

export interface DeepSeekCompletion {
  response: AxiosResponse<NodeJS.ReadableStream>
  sessionId: string
}

export class DeepSeekUpstreamError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DeepSeekUpstreamError'
  }
}

const tokenCache = new Map<string, TokenInfo>()

function tokenCacheKey(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function unixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

function generateCookie(): string {
  const timestamp = Date.now()
  const seconds = Math.floor(timestamp / 1000)
  const session = randomBytes(9).toString('hex')
  return [
    `intercom-HWWAFSESTIME=${timestamp}`,
    `HWWAFSESID=${session}`,
    `Hm_lvt_${randomUUID()}=${seconds},${seconds},${seconds}`,
    `Hm_lpvt_${randomUUID()}=${seconds}`,
    `_frid=${randomUUID()}`,
    `_fr_ssid=${randomUUID()}`,
    `_fr_pvid=${randomUUID()}`,
  ].join('; ')
}

function providerMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback
  const root = data as Record<string, unknown>
  const nested = root.data && typeof root.data === 'object'
    ? root.data as Record<string, unknown>
    : undefined
  return typeof root.msg === 'string'
    ? root.msg
    : typeof nested?.biz_msg === 'string'
      ? nested.biz_msg
      : fallback
}

function providerData(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object') return undefined
  const root = data as Record<string, unknown>
  const nested = root.data && typeof root.data === 'object'
    ? root.data as Record<string, unknown>
    : undefined
  const value = nested?.biz_data ?? root.biz_data
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

function mapTransportError(error: unknown): DeepSeekUpstreamError {
  if (axios.isCancel(error)) {
    return new DeepSeekUpstreamError('provider_request_cancelled', 499, 'DeepSeek request was cancelled.')
  }
  if (error instanceof AxiosError && error.code === 'ECONNABORTED') {
    return new DeepSeekUpstreamError('provider_timeout', 504, 'DeepSeek did not respond in time.')
  }
  if (error instanceof DeepSeekUpstreamError) return error
  return new DeepSeekUpstreamError('provider_unavailable', 502, 'DeepSeek is currently unavailable.')
}

export class DeepSeekAdapter {
  private readonly token: string
  private readonly http: DeepSeekHttpClient
  private readonly requestTimeoutMs: number

  constructor(
    _provider: Provider,
    account: Account,
    options: {
      http?: DeepSeekHttpClient
      requestTimeoutMs?: number
    } = {},
  ) {
    this.token = account.credentials.token ?? ''
    this.http = options.http ?? axios
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
  }

  async checkHealth(signal?: AbortSignal): Promise<void> {
    await this.acquireToken(signal)
  }

  async chatCompletion(
    request: ChatCompletionInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekCompletion> {
    let sessionId: string | undefined

    try {
      const token = await this.acquireToken(signal)
      sessionId = await this.createSession(token, signal)
      const challenge = await this.getChallenge(token, signal)
      const challengeAnswer = await this.calculateChallengeAnswer(challenge)
      const prompt = this.messagesToPrompt(request.messages)
      const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(request)

      const response = await this.http.post<NodeJS.ReadableStream>(
        `${DEEPSEEK_API_BASE}${CHAT_COMPLETION_PATH}`,
        {
          chat_session_id: sessionId,
          parent_message_id: null,
          prompt,
          model_type: modelType,
          ref_file_ids: [],
          search_enabled: searchEnabled,
          thinking_enabled: thinkingEnabled,
          preempt: false,
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...WEB_HEADERS,
            Referer: `https://chat.deepseek.com/a/chat/s/${sessionId}`,
            Cookie: generateCookie(),
            'X-Ds-Pow-Response': challengeAnswer,
          },
          timeout: this.requestTimeoutMs,
          signal,
          validateStatus: () => true,
          responseType: 'stream',
        },
      )

      return { response, sessionId }
    } catch (error) {
      if (sessionId) await this.deleteSession(sessionId)
      throw mapTransportError(error)
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const token = await this.acquireToken()
      const result = await this.http.post(
        `${DEEPSEEK_API_BASE}${SESSION_DELETE_PATH}`,
        { chat_session_id: sessionId },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...WEB_HEADERS,
          },
          timeout: 10_000,
          validateStatus: () => true,
        },
      )
      return result.status === 200
        && Boolean(result.data)
        && typeof result.data === 'object'
        && (result.data as Record<string, unknown>).code === 0
    } catch {
      return false
    }
  }

  private async acquireToken(signal?: AbortSignal): Promise<string> {
    if (!this.token) {
      throw new DeepSeekUpstreamError(
        'provider_authentication_failed',
        401,
        'DeepSeek web token is not configured.',
      )
    }

    const cacheKey = tokenCacheKey(this.token)
    const cached = tokenCache.get(cacheKey)
    if (cached && cached.expiresAt > unixTimestamp()) return cached.accessToken

    let result: AxiosResponse
    try {
      result = await this.http.get(`${DEEPSEEK_API_BASE}/v0/users/current`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...WEB_HEADERS,
        },
        timeout: 15_000,
        signal,
        validateStatus: () => true,
      })
    } catch (error) {
      throw mapTransportError(error)
    }

    if (result.status === 401 || result.status === 403) {
      throw new DeepSeekUpstreamError(
        'provider_authentication_failed',
        result.status,
        'DeepSeek web token is invalid or expired.',
      )
    }
    if (result.status === 429) {
      throw new DeepSeekUpstreamError(
        'provider_rate_limited',
        429,
        'DeepSeek rate limit reached.',
      )
    }
    if (result.status !== 200) {
      throw new DeepSeekUpstreamError(
        'provider_unavailable',
        502,
        'DeepSeek token exchange failed.',
      )
    }

    const accessToken = providerData(result.data)?.token
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new DeepSeekUpstreamError(
        'provider_protocol_changed',
        502,
        'DeepSeek token response format changed.',
      )
    }

    tokenCache.set(cacheKey, {
      accessToken,
      expiresAt: unixTimestamp() + 3600,
    })
    return accessToken
  }

  private async createSession(token: string, signal?: AbortSignal): Promise<string> {
    const result = await this.http.post(
      `${DEEPSEEK_API_BASE}${SESSION_CREATE_PATH}`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...WEB_HEADERS,
          Cookie: generateCookie(),
        },
        timeout: 15_000,
        signal,
        validateStatus: () => true,
      },
    )

    const session = providerData(result.data)?.chat_session
    const sessionId = session && typeof session === 'object'
      ? (session as Record<string, unknown>).id
      : undefined
    if (result.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new DeepSeekUpstreamError(
        result.status === 401 || result.status === 403
          ? 'provider_authentication_failed'
          : 'provider_protocol_changed',
        result.status === 401 || result.status === 403 ? result.status : 502,
        providerMessage(result.data, 'DeepSeek session could not be created.'),
      )
    }
    return sessionId
  }

  private async getChallenge(token: string, signal?: AbortSignal): Promise<ChallengeResponse> {
    const result = await this.http.post(
      `${DEEPSEEK_API_BASE}${CHALLENGE_PATH}`,
      { target_path: '/api/v0/chat/completion' },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...WEB_HEADERS,
        },
        timeout: 15_000,
        signal,
        validateStatus: () => true,
      },
    )

    const challenge = providerData(result.data)?.challenge
    if (result.status !== 200 || !challenge || typeof challenge !== 'object') {
      throw new DeepSeekUpstreamError(
        'provider_protocol_changed',
        502,
        providerMessage(result.data, 'DeepSeek challenge response format changed.'),
      )
    }
    return challenge as ChallengeResponse
  }

  private async calculateChallengeAnswer(challenge: ChallengeResponse): Promise<string> {
    const {
      algorithm,
      challenge: challengeValue,
      salt,
      difficulty,
      expire_at: expiresAt,
      signature,
    } = challenge
    if (algorithm !== 'DeepSeekHashV1') {
      throw new DeepSeekUpstreamError(
        'provider_protocol_changed',
        502,
        'DeepSeek challenge algorithm changed.',
      )
    }

    const deepSeekHash = await getDeepSeekHash()
    const answer = deepSeekHash.calculateHash(
      algorithm,
      challengeValue,
      salt,
      difficulty,
      expiresAt,
    )
    if (answer === undefined) {
      throw new DeepSeekUpstreamError(
        'provider_protocol_changed',
        502,
        'DeepSeek challenge calculation failed.',
      )
    }

    return Buffer.from(JSON.stringify({
      algorithm,
      challenge: challengeValue,
      salt,
      answer,
      signature,
      target_path: '/api/v0/chat/completion',
    })).toString('base64')
  }

  private messagesToPrompt(messages: ChatMessage[]): string {
    return messages
      .map((message, index) => {
        const content = message.content
          .replaceAll('<｜Assistant｜>', '[Assistant marker]')
          .replaceAll('<｜User｜>', '[User marker]')
          .replaceAll('<｜end of sentence｜>', '[End marker]')
        if (message.role === 'assistant') {
          return `<｜Assistant｜>${content}<｜end of sentence｜>`
        }
        if (message.role === 'system') {
          return index === 0
            ? content
            : `<｜User｜>System instructions:\n${content}`
        }
        return index === 0 ? content : `<｜User｜>${content}`
      })
      .join('')
  }

  static isDeepSeekProvider(provider: Provider): boolean {
    return provider.id === 'deepseek'
  }
}
