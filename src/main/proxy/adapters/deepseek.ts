import { createHash, randomBytes, randomUUID } from 'node:crypto'
import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
} from 'axios'
import { getDeepSeekHash } from '../../lib/challenge'
import {
  DEEPSEEK_WEB_API_BASE,
  DEEPSEEK_WEB_HEADERS,
  inspectDeepSeekCurrentUser,
} from '../../providers/deepseek-web.js'
import type { Account, Provider } from '../../store/types'
import type { ChatContentPart, ChatMessage } from '../types'
import {
  DeepSeekProviderError,
  providerErrorFromPayload,
} from './deepseek-stream'
import {
  DeepSeekSessionPool,
  type DeepSeekSessionPoolState,
} from './deepseek-session-pool'
import { resolveDeepSeekChatOptions } from './providerModelOptions'

const SESSION_CREATE_PATH = '/v0/chat_session/create'
const SESSION_DELETE_PATH = '/v0/chat_session/delete'
const CHAT_COMPLETION_PATH = '/v0/chat/completion'
const CHALLENGE_PATH = '/v0/chat/create_pow_challenge'
const UPLOAD_FILE_PATH = '/v0/file/upload_file'
const FETCH_FILES_PATH = '/v0/file/fetch_files'
const CHAT_COMPLETION_TARGET_PATH = '/api/v0/chat/completion'
const UPLOAD_FILE_TARGET_PATH = '/api/v0/file/upload_file'
const MAX_MEDIA_FILES = 4
const MAX_MEDIA_FILE_BYTES = 6 * 1024 * 1024
const MAX_MEDIA_TOTAL_BYTES = 12 * 1024 * 1024
const FILE_READY_POLL_ATTEMPTS = 30
const FILE_READY_POLL_INTERVAL_MS = 1000

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

interface InlineMediaFile {
  data: Buffer
  filename: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf'
}

interface DeepSeekFileMetadata {
  id: string
  status: string
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
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'DeepSeekUpstreamError'
  }
}

const tokenCache = new Map<string, TokenInfo>()
const sessionPool = new DeepSeekSessionPool()

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
  if (error instanceof DeepSeekProviderError) {
    return new DeepSeekUpstreamError(
      error.code,
      error.status,
      error.message,
      error.retryAfterMs,
    )
  }
  return new DeepSeekUpstreamError('provider_unavailable', 502, 'DeepSeek is currently unavailable.')
}

export class DeepSeekAdapter {
  private readonly accountId: string
  private readonly token: string
  private readonly http: DeepSeekHttpClient
  private readonly requestTimeoutMs: number
  private readonly sessionTtlMs: number
  private readonly sessionKey: string

  constructor(
    _provider: Provider,
    account: Account,
    options: {
      http?: DeepSeekHttpClient
      requestTimeoutMs?: number
      sessionTtlMs?: number
    } = {},
  ) {
    this.accountId = account.id
    this.token = account.credentials.token ?? ''
    this.http = options.http ?? axios
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000
    this.sessionTtlMs = options.sessionTtlMs ?? 300_000
    this.sessionKey = `${this.accountId}:${tokenCacheKey(this.token)}`
  }

  async checkHealth(signal?: AbortSignal): Promise<void> {
    await this.acquireToken(signal)
  }

  async chatCompletion(
    request: ChatCompletionInput,
    signal?: AbortSignal,
  ): Promise<DeepSeekCompletion> {
    let sessionId: string | undefined
    let accessToken: string | undefined

    try {
      const mediaFiles = extractInlineMediaFiles(request.messages)
      const { modelType, searchEnabled, thinkingEnabled } = resolveDeepSeekChatOptions(request)
      if (mediaFiles.length > 0 && modelType === 'expert') {
        throw new DeepSeekUpstreamError(
          'invalid_media_input',
          400,
          'DeepSeek expert mode does not accept direct file references. Extract media with a compatible model first.',
        )
      }
      accessToken = await this.acquireToken(signal)
      const lease = await sessionPool.acquire(
        this.sessionKey,
        mediaFiles.length > 0 ? 0 : this.sessionTtlMs,
        () => this.createSession(accessToken!, signal),
        (retiredSessionId) => this.deleteSessionWithToken(retiredSessionId, accessToken!),
      )
      sessionId = lease.sessionId
      const refFileIds = await this.uploadFiles(
        mediaFiles,
        accessToken,
        modelType,
        thinkingEnabled,
        signal,
      )
      const challenge = await this.getChallenge(
        accessToken,
        CHAT_COMPLETION_TARGET_PATH,
        signal,
      )
      const challengeAnswer = await this.calculateChallengeAnswer(
        challenge,
        CHAT_COMPLETION_TARGET_PATH,
      )
      const prompt = this.messagesToPrompt(request.messages)

      const response = await this.http.post<NodeJS.ReadableStream>(
        `${DEEPSEEK_WEB_API_BASE}${CHAT_COMPLETION_PATH}`,
        {
          chat_session_id: sessionId,
          parent_message_id: null,
          prompt,
          model_type: modelType,
          ref_file_ids: refFileIds,
          search_enabled: searchEnabled,
          thinking_enabled: thinkingEnabled,
          preempt: false,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...DEEPSEEK_WEB_HEADERS,
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
      const failure = mapTransportError(error)
      if (sessionId) {
        if (isReusableAfterFailure(failure.code)) {
          await this.releaseSession(sessionId)
        } else {
          await this.invalidateSession(sessionId, accessToken)
        }
      }
      throw failure
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    const released = sessionPool.release(this.sessionKey, sessionId)
    if (released.retired) await this.deleteSession(sessionId)
  }

  async invalidateSession(sessionId: string, accessToken?: string): Promise<void> {
    const invalidated = sessionPool.invalidate(this.sessionKey, sessionId)
    if (!invalidated) return

    try {
      const token = accessToken ?? await this.acquireToken()
      await this.deleteSessionWithToken(sessionId, token)
    } catch {
      // Invalid sessions are removed locally even when upstream cleanup is unavailable.
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    sessionPool.invalidate(this.sessionKey, sessionId)
    try {
      const token = await this.acquireToken()
      return await this.deleteSessionWithToken(sessionId, token)
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
      result = await this.http.get(`${DEEPSEEK_WEB_API_BASE}/v0/users/current`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...DEEPSEEK_WEB_HEADERS,
        },
        timeout: 15_000,
        signal,
        validateStatus: () => true,
      })
    } catch (error) {
      throw mapTransportError(error)
    }

    const providerFailure = providerErrorFromPayload(result.data)
    if (providerFailure) throw mapTransportError(providerFailure)

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

    const inspection = inspectDeepSeekCurrentUser(result.data)
    if (inspection.kind === 'suspended') {
      const retryAfterMs = inspection.suspendedUntil === undefined
        ? undefined
        : Math.max(1000, inspection.suspendedUntil - Date.now())
      throw new DeepSeekUpstreamError(
        'provider_account_suspended',
        403,
        'The DeepSeek account is temporarily suspended by the provider.',
        retryAfterMs,
      )
    }
    if (inspection.kind !== 'valid') {
      throw new DeepSeekUpstreamError(
        inspection.kind === 'authentication_error'
          ? 'provider_authentication_failed'
          : 'provider_protocol_changed',
        inspection.kind === 'authentication_error' ? 401 : 502,
        inspection.kind === 'authentication_error'
          ? 'DeepSeek web token is invalid or expired.'
          : 'DeepSeek token response format changed.',
      )
    }
    const accessToken = inspection.accessToken

    tokenCache.set(cacheKey, {
      accessToken,
      expiresAt: unixTimestamp() + 3600,
    })
    return accessToken
  }

  private async createSession(token: string, signal?: AbortSignal): Promise<string> {
    const result = await this.http.post(
      `${DEEPSEEK_WEB_API_BASE}${SESSION_CREATE_PATH}`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...DEEPSEEK_WEB_HEADERS,
          Cookie: generateCookie(),
        },
        timeout: 15_000,
        signal,
        validateStatus: () => true,
      },
    )

    const providerFailure = providerErrorFromPayload(result.data)
    if (providerFailure) throw providerFailure

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

  private async deleteSessionWithToken(sessionId: string, token: string): Promise<boolean> {
    const result = await this.http.post(
      `${DEEPSEEK_WEB_API_BASE}${SESSION_DELETE_PATH}`,
      { chat_session_id: sessionId },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...DEEPSEEK_WEB_HEADERS,
        },
        timeout: 10_000,
        validateStatus: () => true,
      },
    )
    return result.status === 200
      && Boolean(result.data)
      && typeof result.data === 'object'
      && (result.data as Record<string, unknown>).code === 0
  }

  private async getChallenge(
    token: string,
    targetPath: string,
    signal?: AbortSignal,
  ): Promise<ChallengeResponse> {
    const result = await this.http.post(
      `${DEEPSEEK_WEB_API_BASE}${CHALLENGE_PATH}`,
      { target_path: targetPath },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          ...DEEPSEEK_WEB_HEADERS,
        },
        timeout: 15_000,
        signal,
        validateStatus: () => true,
      },
    )

    const providerFailure = providerErrorFromPayload(result.data)
    if (providerFailure) throw providerFailure

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

  private async calculateChallengeAnswer(
    challenge: ChallengeResponse,
    targetPath: string,
  ): Promise<string> {
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
      target_path: targetPath,
    })).toString('base64')
  }

  private async uploadFiles(
    files: InlineMediaFile[],
    token: string,
    modelType: string,
    _thinkingEnabled: boolean,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const fileIds: string[] = []
    for (const file of files) {
      const challenge = await this.getChallenge(token, UPLOAD_FILE_TARGET_PATH, signal)
      const challengeAnswer = await this.calculateChallengeAnswer(
        challenge,
        UPLOAD_FILE_TARGET_PATH,
      )
      const multipart = buildMultipartFileBody(file)
      const result = await this.http.post(
        `${DEEPSEEK_WEB_API_BASE}${UPLOAD_FILE_PATH}`,
        multipart.body,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...DEEPSEEK_WEB_HEADERS,
            Accept: 'application/json',
            'Content-Type': multipart.contentType,
            Cookie: generateCookie(),
            'X-Ds-Pow-Response': challengeAnswer,
            'X-File-Size': String(file.data.length),
            'X-Model-Type': modelType,
            'X-Thinking-Enabled': '1',
          },
          timeout: this.requestTimeoutMs,
          signal,
          validateStatus: () => true,
        },
      )

      const providerFailure = providerErrorFromPayload(result.data)
      if (providerFailure) throw providerFailure
      if (result.status === 401 || result.status === 403) {
        throw new DeepSeekUpstreamError(
          'provider_authentication_failed',
          result.status,
          'DeepSeek rejected the file upload session.',
        )
      }
      if (result.status === 429) {
        throw new DeepSeekUpstreamError(
          'provider_rate_limited',
          429,
          'DeepSeek rate limited the file upload.',
        )
      }
      const uploaded = findFileMetadata(result.data)
      if (result.status !== 200 || !uploaded?.id) {
        throw new DeepSeekUpstreamError(
          'provider_media_upload_failed',
          502,
          'DeepSeek could not accept the attached file.',
        )
      }
      await this.waitForFileReady(uploaded, token, signal)
      fileIds.push(uploaded.id)
    }
    return fileIds
  }

  private async waitForFileReady(
    uploaded: DeepSeekFileMetadata,
    token: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (isFileReadyStatus(uploaded.status)) return

    for (let attempt = 0; attempt < FILE_READY_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await abortableDelay(FILE_READY_POLL_INTERVAL_MS, signal)
      }
      const result = await this.http.get(
        `${DEEPSEEK_WEB_API_BASE}${FETCH_FILES_PATH}?file_ids=${encodeURIComponent(uploaded.id)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            ...DEEPSEEK_WEB_HEADERS,
            Accept: 'application/json',
          },
          timeout: 15_000,
          signal,
          validateStatus: () => true,
        },
      )
      const providerFailure = providerErrorFromPayload(result.data)
      if (providerFailure) throw providerFailure
      if (result.status === 401 || result.status === 403) {
        throw new DeepSeekUpstreamError(
          'provider_authentication_failed',
          result.status,
          'DeepSeek rejected the file status request.',
        )
      }
      const current = findFileMetadata(result.data, uploaded.id)
      if (result.status === 200 && current && isFileReadyStatus(current.status)) return
    }

    throw new DeepSeekUpstreamError(
      'provider_media_processing_timeout',
      504,
      'DeepSeek did not finish processing the attached file in time.',
    )
  }

  private messagesToPrompt(messages: ChatMessage[]): string {
    return messages
      .map((message, index) => {
        const content = messageContentToPrompt(message.content)
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

  static sessionPoolState(): DeepSeekSessionPoolState {
    return sessionPool.state()
  }

  static clearSessionPool(): void {
    sessionPool.clear()
  }
}

function messageContentToPrompt(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content

  const text = content
    .filter((part): part is Extract<ChatContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim()
  const filenames = content
    .filter((part) => part.type !== 'text')
    .map((part, index) => mediaPartFilename(part, index))

  if (filenames.length === 0) return text
  const attachmentLabel = `[Attached files: ${filenames.join(', ')}]`
  return text ? `${text}\n${attachmentLabel}` : attachmentLabel
}

function extractInlineMediaFiles(messages: ChatMessage[]): InlineMediaFile[] {
  const files: InlineMediaFile[] = []
  const seen = new Set<string>()
  let totalBytes = 0

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const [index, part] of message.content.entries()) {
      if (part.type === 'text') continue
      if (files.length >= MAX_MEDIA_FILES) {
        throw new DeepSeekUpstreamError(
          'invalid_media_input',
          400,
          `At most ${MAX_MEDIA_FILES} attached files are supported.`,
        )
      }
      const source = part.type === 'image_url'
        ? part.image_url.url
        : part.file.file_data
      const decoded = decodeInlineMediaDataUrl(source)
      if (decoded.data.length > MAX_MEDIA_FILE_BYTES) {
        throw new DeepSeekUpstreamError(
          'invalid_media_input',
          413,
          `An attached file exceeds the ${MAX_MEDIA_FILE_BYTES / 1024 / 1024} MiB limit.`,
        )
      }
      totalBytes += decoded.data.length
      if (totalBytes > MAX_MEDIA_TOTAL_BYTES) {
        throw new DeepSeekUpstreamError(
          'invalid_media_input',
          413,
          `Attached files exceed the ${MAX_MEDIA_TOTAL_BYTES / 1024 / 1024} MiB request limit.`,
        )
      }
      assertMediaMagicBytes(decoded.mimeType, decoded.data)
      const fingerprint = createHash('sha256')
        .update(decoded.mimeType)
        .update('\0')
        .update(decoded.data)
        .digest('hex')
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)
      files.push({
        data: decoded.data,
        mimeType: decoded.mimeType,
        filename: safeMediaFilename(mediaPartFilename(part, index), decoded.mimeType),
      })
    }
  }

  return files
}

function decodeInlineMediaDataUrl(source: string): {
  data: Buffer
  mimeType: InlineMediaFile['mimeType']
} {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=_-]+)$/i.exec(source.trim())
  if (!match) {
    throw new DeepSeekUpstreamError(
      'invalid_media_input',
      400,
      'Attached files must use an inline base64 data URL.',
    )
  }
  const mimeType = match[1].toLowerCase() as InlineMediaFile['mimeType']
  if (!isAllowedMediaMimeType(mimeType)) {
    throw new DeepSeekUpstreamError(
      'invalid_media_input',
      400,
      'Only PNG, JPEG, WebP, and PDF attachments are supported.',
    )
  }
  const payload = match[2]
  if (!/^[a-z0-9+/_-]+={0,2}$/i.test(payload) || payload.length % 4 === 1) {
    throw new DeepSeekUpstreamError(
      'invalid_media_input',
      400,
      'The attached file contains invalid base64 data.',
    )
  }
  const data = Buffer.from(payload.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
  if (data.length === 0) {
    throw new DeepSeekUpstreamError(
      'invalid_media_input',
      400,
      'The attached file is empty.',
    )
  }
  return { data, mimeType }
}

function assertMediaMagicBytes(mimeType: InlineMediaFile['mimeType'], data: Buffer): void {
  const valid = mimeType === 'application/pdf'
    ? data.subarray(0, 5).toString('ascii') === '%PDF-'
    : mimeType === 'image/png'
      ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : mimeType === 'image/jpeg'
        ? data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
        : data.length >= 12
          && data.subarray(0, 4).toString('ascii') === 'RIFF'
          && data.subarray(8, 12).toString('ascii') === 'WEBP'
  if (!valid) {
    throw new DeepSeekUpstreamError(
      'invalid_media_input',
      400,
      'The attached file signature does not match its declared media type.',
    )
  }
}

function isAllowedMediaMimeType(value: string): value is InlineMediaFile['mimeType'] {
  return value === 'image/png'
    || value === 'image/jpeg'
    || value === 'image/webp'
    || value === 'application/pdf'
}

function mediaPartFilename(part: Exclude<ChatContentPart, { type: 'text' }>, index: number): string {
  const value = part.type === 'file'
    ? part.file.filename
    : part.filename || `image-${index + 1}`
  return value
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.split('')
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 ? '_' : character
    })
    .join('')
    .replaceAll('<｜Assistant｜>', '[Assistant marker]')
    .replaceAll('<｜User｜>', '[User marker]')
    .replaceAll('<｜end of sentence｜>', '[End marker]')
    .trim()
    .slice(0, 120) || `attachment-${index + 1}`
}

function safeMediaFilename(value: string, mimeType: InlineMediaFile['mimeType']): string {
  const extension = mimeType === 'application/pdf'
    ? '.pdf'
    : mimeType === 'image/jpeg'
      ? '.jpg'
      : mimeType === 'image/webp'
        ? '.webp'
        : '.png'
  const basename = value
    .replaceAll('\\', '/')
    .split('/')
    .at(-1)
    ?.split('')
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127 || character === '"' ? '_' : character
    })
    .join('')
    .replace(/[^a-z0-9._ -]/gi, '_')
    .trim()
    .slice(0, 120) || 'attachment'
  return basename.toLowerCase().endsWith(extension) ? basename : `${basename}${extension}`
}

function buildMultipartFileBody(file: InlineMediaFile): { body: Buffer; contentType: string } {
  const boundary = `----chat2api-${randomBytes(18).toString('hex')}`
  const header = Buffer.from([
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${file.filename}"`,
    `Content-Type: ${file.mimeType}`,
    '',
    '',
  ].join('\r\n'))
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    body: Buffer.concat([header, file.data, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

function findFileMetadata(value: unknown, expectedId?: string): DeepSeekFileMetadata | undefined {
  const seen = new Set<unknown>()
  const visit = (candidate: unknown): DeepSeekFileMetadata | undefined => {
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) return undefined
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const found = visit(item)
        if (found) return found
      }
      return undefined
    }
    const record = candidate as Record<string, unknown>
    const id = typeof record.file_id === 'string'
      ? record.file_id.trim()
      : typeof record.id === 'string'
        ? record.id.trim()
        : ''
    if (id && (!expectedId || id === expectedId)) {
      const status = typeof record.status === 'string'
        ? record.status
        : typeof record.file_status === 'string'
          ? record.file_status
          : ''
      return { id, status: status.trim().toLowerCase() }
    }
    for (const nested of Object.values(record)) {
      const found = visit(nested)
      if (found) return found
    }
    return undefined
  }
  return visit(value)
}

function isFileReadyStatus(status: string): boolean {
  return [
    'processed',
    'ready',
    'done',
    'available',
    'success',
    'completed',
    'finished',
  ].includes(status.trim().toLowerCase())
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DeepSeekUpstreamError(
      'provider_request_cancelled',
      499,
      'DeepSeek request was cancelled.',
    ))
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DeepSeekUpstreamError(
        'provider_request_cancelled',
        499,
        'DeepSeek request was cancelled.',
      ))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isReusableAfterFailure(code: string): boolean {
  return code === 'provider_account_suspended'
    || code === 'provider_rate_limited'
    || code === 'provider_expert_busy'
}
