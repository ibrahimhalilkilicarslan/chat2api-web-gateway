import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'

type OutputPath = 'thinking' | 'content'

interface StreamChunk {
  p?: string
  v?: unknown
  o?: string
  type?: string
  finish_reason?: string
}

interface SearchResult {
  url: string
  title: string
  citeIndex?: number
}

interface ContentDelta {
  path: OutputPath
  content: string
}

const SEARCH_CONTROL_MARKER_PATTERN = /^(SEARCH|WEB_SEARCH|SEARCHING)(?:\s+|$)/i
const EXPERT_BUSY_RETRY_MS = 30_000

export class DeepSeekProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'DeepSeekProviderError'
  }
}

export function providerErrorFromJsonResponse(value: string): DeepSeekProviderError | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }

  return providerErrorFromPayload(parsed)
}

export function providerErrorFromPayload(value: unknown): DeepSeekProviderError | undefined {
  const root = record(value)
  const data = record(root?.data)
  const businessData = record(data?.biz_data) ?? record(root?.biz_data)
  const businessCode = typeof data?.biz_code === 'number'
    ? data.biz_code
    : typeof root?.biz_code === 'number'
      ? root.biz_code
      : undefined
  const businessMessage = safeString(data?.biz_msg ?? root?.biz_msg).toLowerCase()
  const chat = record(businessData?.chat)
  const isMuted = businessData?.is_muted === true
    || businessData?.is_muted === 1
    || chat?.is_muted === true
    || chat?.is_muted === 1

  if (businessCode === 5 || isMuted || businessMessage.includes('user is muted')) {
    const muteUntil = businessData?.mute_until ?? chat?.mute_until
    const muteUntilSeconds = typeof muteUntil === 'number'
      && Number.isFinite(muteUntil)
      ? muteUntil
      : undefined
    const retryAfterMs = muteUntilSeconds === undefined
      ? undefined
      : Math.max(1000, Math.round(muteUntilSeconds * 1000 - Date.now()))
    return new DeepSeekProviderError(
      'provider_account_suspended',
      403,
      'The DeepSeek account is temporarily suspended by the provider.',
      retryAfterMs,
    )
  }

  if (businessCode === 40_003) {
    return new DeepSeekProviderError(
      'provider_authentication_failed',
      401,
      'The DeepSeek web session is invalid or expired.',
    )
  }

  if (businessCode === 429 || businessMessage.includes('rate limit')) {
    return new DeepSeekProviderError(
      'provider_rate_limited',
      429,
      'DeepSeek rate limit reached. Retry later.',
    )
  }

  if (businessMessage.includes('expert_busy_use_default')) {
    return expertBusyError()
  }

  if (businessCode !== undefined && businessCode !== 0) {
    return new DeepSeekProviderError(
      providerResponseErrorCode(`biz_${businessCode}`),
      502,
      'DeepSeek could not complete the request.',
    )
  }

  return undefined
}

export interface DeepSeekStreamOutcome {
  status: 'success' | 'provider_error' | 'interrupted'
  errorCode?: string
  statusCode?: number
  retryAfterMs?: number
}

function providerErrorFromChunk(chunk: StreamChunk): DeepSeekProviderError | undefined {
  if (chunk.type !== 'error') return undefined
  const finishReason = safeString(chunk.finish_reason).trim().toLowerCase()
  if (finishReason === 'rate_limit_reached') {
    return new DeepSeekProviderError(
      'provider_rate_limited',
      429,
      'DeepSeek rate limit reached. Retry later.',
    )
  }
  if (finishReason === 'expert_busy_use_default') return expertBusyError()
  return new DeepSeekProviderError(
    providerResponseErrorCode(chunk.finish_reason),
    502,
    'DeepSeek could not complete the request.',
  )
}

function expertBusyError(): DeepSeekProviderError {
  return new DeepSeekProviderError(
    'provider_expert_busy',
    503,
    'DeepSeek Expert capacity is temporarily unavailable. Retry shortly.',
    EXPERT_BUSY_RETRY_MS,
  )
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function safeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function providerResponseErrorCode(reason: unknown): string {
  const normalized = safeString(reason)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return normalized
    ? `provider_response_error_${normalized}`
    : 'provider_response_error'
}

function responseId(): string {
  return `chatcmpl-${randomUUID().replaceAll('-', '')}`
}

class DeepSeekEventDecoder {
  private currentPath: OutputPath
  private readonly searchResults = new Map<string, SearchResult>()

  constructor(
    private readonly thinkingEnabled: boolean,
    private readonly webSearchEnabled: boolean,
  ) {
    this.currentPath = thinkingEnabled ? 'thinking' : 'content'
  }

  process(chunk: StreamChunk): ContentDelta[] {
    const output: ContentDelta[] = []
    const value = chunk.v
    const valueRecord = record(value)
    const response = record(valueRecord?.response)

    if (response) {
      if (typeof response.thinking_enabled === 'boolean') {
        this.currentPath = response.thinking_enabled ? 'thinking' : 'content'
      }
      this.processFragments(response.fragments, output)
    } else if (chunk.p === 'response/fragments') {
      this.processFragments(value, output)
    } else if (chunk.p === 'response' && Array.isArray(value)) {
      for (const operation of value) {
        const operationRecord = record(operation)
        if (!operationRecord) continue
        if (operationRecord.p === 'response') {
          const nestedResponse = record(operationRecord.v)
          if (typeof nestedResponse?.thinking_enabled === 'boolean') {
            this.currentPath = nestedResponse.thinking_enabled ? 'thinking' : 'content'
          }
        }
        if (Array.isArray(operationRecord.v)) {
          const content = operationRecord.v
            .map((entry) => safeString(record(entry)?.content))
            .join('')
          this.pushContent(output, content)
        }
      }
    }

    if (
      (chunk.p === 'response/search_results'
        || /^response\/fragments\/-?\d+\/results$/.test(chunk.p ?? ''))
      && Array.isArray(value)
    ) {
      if (chunk.o === 'BATCH') this.applySearchBatch(value)
      else this.mergeSearchResults(value)
      return output
    }

    if (typeof value === 'string') this.pushContent(output, value)
    return output
  }

  citations(): string {
    return [...this.searchResults.values()]
      .filter((entry) => Number.isFinite(entry.citeIndex))
      .sort((left, right) => (left.citeIndex ?? 0) - (right.citeIndex ?? 0))
      .map((entry) => `[${entry.citeIndex}]: [${entry.title}](${entry.url})`)
      .join('\n')
  }

  private processFragments(value: unknown, output: ContentDelta[]): void {
    if (!Array.isArray(value)) return
    for (const fragment of value) {
      const fragmentRecord = record(fragment)
      if (!fragmentRecord) continue
      if (Array.isArray(fragmentRecord.results)) {
        this.mergeSearchResults(fragmentRecord.results)
      }
      const content = safeString(fragmentRecord.content)
      if (!content) continue
      if (fragmentRecord.type === 'THINK') this.currentPath = 'thinking'
      if (fragmentRecord.type === 'ANSWER' || fragmentRecord.type === 'RESPONSE') {
        this.currentPath = 'content'
      }
      this.pushContent(output, content)
    }
  }

  private pushContent(output: ContentDelta[], value: string): void {
    const withoutFinishMarker = value.replace(/FINISHED/g, '')
    const withoutSearchMarker = this.webSearchEnabled
      ? withoutFinishMarker.replace(SEARCH_CONTROL_MARKER_PATTERN, '')
      : withoutFinishMarker
    const content = withoutSearchMarker.replace(/\[citation:(\d+)\]/g, '[$1]')
    if (content) output.push({ path: this.currentPath, content })
  }

  private mergeSearchResults(values: unknown[]): void {
    for (const value of values) {
      const item = record(value)
      const rawUrl = safeString(item?.url)
      const rawTitle = safeString(item?.title)
      if (!rawUrl || !rawTitle) continue

      let url: URL
      try {
        url = new URL(rawUrl)
      } catch {
        continue
      }
      if (
        !['http:', 'https:'].includes(url.protocol)
        || url.username
        || url.password
      ) {
        continue
      }

      const citeIndex = typeof item?.cite_index === 'number'
        ? item.cite_index
        : typeof item?.citeIndex === 'number'
          ? item.citeIndex
          : undefined
      this.searchResults.set(url.href, {
        url: url.href,
        title: rawTitle
          .replace(/[\r\n[\]]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300),
        citeIndex,
      })
    }
  }

  private applySearchBatch(values: unknown[]): void {
    const entries = [...this.searchResults.values()]
    for (const value of values) {
      const operation = record(value)
      const match = safeString(operation?.p).match(/^(\d+)\/cite_index$/)
      if (!match) continue
      const index = Number.parseInt(match[1], 10)
      const citeIndex = operation?.v
      if (!entries[index] || typeof citeIndex !== 'number' || !Number.isFinite(citeIndex)) continue
      entries[index].citeIndex = citeIndex
      this.searchResults.set(entries[index].url, entries[index])
    }
  }
}

export class DeepSeekStreamHandler {
  private readonly id: string
  private readonly created = Math.floor(Date.now() / 1000)
  private readonly decoder: DeepSeekEventDecoder
  private isFirstChunk = true
  private isDone = false
  private hasOutput = false
  private cleanupStarted = false
  private readonly resolveOutcome: (outcome: DeepSeekStreamOutcome) => void
  readonly outcome: Promise<DeepSeekStreamOutcome>

  constructor(
    private readonly model: string,
    private readonly onEnd?: (outcome: DeepSeekStreamOutcome) => void | Promise<void>,
    webSearchEnabled = false,
    reasoningEffort?: string,
    id = responseId(),
  ) {
    this.id = id
    this.decoder = new DeepSeekEventDecoder(Boolean(reasoningEffort), webSearchEnabled)
    let resolveOutcome!: (outcome: DeepSeekStreamOutcome) => void
    this.outcome = new Promise((resolve) => {
      resolveOutcome = resolve
    })
    this.resolveOutcome = resolveOutcome
  }

  handleStream(stream: NodeJS.ReadableStream): NodeJS.ReadableStream {
    const source = stream as Readable
    const output = new PassThrough()
    let buffer = ''
    let nonSseBody = ''

    source.on('data', (chunk: Buffer | string) => {
      if (this.isDone) return
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim()) continue
        if (!line.startsWith('data:')) {
          nonSseBody += line
          continue
        }
        const data = line.slice(5).trim()
        if (data === '[DONE]') {
          this.finishStream(output)
          return
        }

        const parsed = this.parseSse(data)
        if (!parsed) continue
        const providerError = providerErrorFromChunk(parsed)
        if (providerError) {
          this.failStream(output, providerError)
          return
        }
        for (const delta of this.decoder.process(parsed)) {
          this.hasOutput = true
          output.write(this.createChunk(this.toPublicDelta(delta)))
        }
      }
    })

    source.once('end', () => {
      const providerError = providerErrorFromJsonResponse(`${nonSseBody}${buffer}`)
      if (providerError) {
        this.failStream(output, providerError)
        return
      }
      this.finishStream(output)
    })
    source.once('error', (error) => {
      if (!this.isDone) {
        this.isDone = true
        output.destroy(error)
      }
      this.cleanup({ status: 'interrupted' })
    })
    output.once('close', () => {
      if (!this.isDone && !source.destroyed) source.destroy()
      this.cleanup({ status: 'interrupted' })
    })

    return output
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<unknown> {
    let content = ''
    let reasoningContent = ''
    let providerError: DeepSeekProviderError | undefined
    let outcome: DeepSeekStreamOutcome = { status: 'success' }

    try {
      let buffer = ''
      let nonSseBody = ''
      for await (const chunk of stream) {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          if (!line.startsWith('data:')) {
            nonSseBody += line
            continue
          }
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          const parsed = this.parseSse(data)
          if (!parsed) continue
          providerError = providerErrorFromChunk(parsed)
          if (providerError) throw providerError
          for (const delta of this.decoder.process(parsed)) {
            if (delta.path === 'thinking') reasoningContent += delta.content
            else content += delta.content
          }
        }
      }

      const jsonError = providerErrorFromJsonResponse(`${nonSseBody}${buffer}`)
      if (jsonError) throw jsonError

      const citations = this.decoder.citations()
      const answer = content.trim()
      const answerWithCitations = citations
        ? answer ? `${answer}\n\n${citations}` : citations
        : answer
      const reasoning = reasoningContent.trim()
      if (!answerWithCitations && !reasoning) {
        throw new DeepSeekProviderError(
          'provider_empty_response',
          502,
          'DeepSeek returned an empty response.',
        )
      }

      return {
        id: this.id,
        model: this.model,
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: answerWithCitations,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
          finish_reason: 'stop',
        }],
        created: this.created,
      }
    } catch (error) {
      outcome = error instanceof DeepSeekProviderError
        ? {
            status: 'provider_error',
            errorCode: error.code,
            statusCode: error.status,
            retryAfterMs: error.retryAfterMs,
          }
        : { status: 'interrupted', statusCode: 502 }
      throw error
    } finally {
      await this.cleanup(outcome)
    }
  }

  private parseSse(data: string): StreamChunk | undefined {
    try {
      const parsed = JSON.parse(data)
      return record(parsed) as StreamChunk | undefined
    } catch {
      return undefined
    }
  }

  private toPublicDelta(delta: ContentDelta): {
    role?: 'assistant'
    content?: string
    reasoning_content?: string
  } {
    const result: {
      role?: 'assistant'
      content?: string
      reasoning_content?: string
    } = {}
    if (this.isFirstChunk) {
      result.role = 'assistant'
      this.isFirstChunk = false
    }
    if (delta.path === 'thinking') result.reasoning_content = delta.content
    else result.content = delta.content
    return result
  }

  private createChunk(
    delta: { role?: 'assistant'; content?: string; reasoning_content?: string },
    finishReason: 'stop' | null = null,
  ): string {
    return `data: ${JSON.stringify({
      id: this.id,
      model: this.model,
      object: 'chat.completion.chunk',
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
      created: this.created,
    })}\n\n`
  }

  private finishStream(output: PassThrough): void {
    if (this.isDone) return
    const citations = this.decoder.citations()
    if (!this.hasOutput && !citations) {
      this.failStream(
        output,
        new DeepSeekProviderError(
          'provider_empty_response',
          502,
          'DeepSeek returned an empty response.',
        ),
      )
      return
    }
    this.isDone = true
    if (citations) output.write(this.createChunk({ content: `\n\n${citations}` }))
    output.write(this.createChunk({}, 'stop'))
    output.write('data: [DONE]\n\n')
    output.end()
    this.cleanup({ status: 'success' })
  }

  private failStream(output: PassThrough, error: DeepSeekProviderError): void {
    if (this.isDone) return
    this.isDone = true
    output.write(`data: ${JSON.stringify({
      error: {
        message: error.message,
        type: 'provider_error',
        param: null,
        code: error.code,
      },
    })}\n\n`)
    output.write('data: [DONE]\n\n')
    output.end()
    this.cleanup({
      status: 'provider_error',
      errorCode: error.code,
      statusCode: error.status,
      retryAfterMs: error.retryAfterMs,
    })
  }

  private async cleanup(outcome: DeepSeekStreamOutcome): Promise<void> {
    if (this.cleanupStarted) return
    this.cleanupStarted = true
    try {
      await this.onEnd?.(outcome)
    } catch {
      // Cleanup is best effort and must not alter the client response.
    } finally {
      this.resolveOutcome(outcome)
    }
  }
}
