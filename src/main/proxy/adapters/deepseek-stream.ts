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

export class DeepSeekProviderError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DeepSeekProviderError'
  }
}

function providerErrorFromChunk(chunk: StreamChunk): DeepSeekProviderError | undefined {
  if (chunk.type !== 'error') return undefined
  if (chunk.finish_reason === 'rate_limit_reached') {
    return new DeepSeekProviderError(
      'provider_rate_limited',
      429,
      'DeepSeek rate limit reached. Retry later.',
    )
  }
  return new DeepSeekProviderError(
    'provider_response_error',
    502,
    'DeepSeek could not complete the request.',
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

function responseId(): string {
  return `chatcmpl_${randomUUID().replaceAll('-', '')}`
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

  constructor(
    private readonly model: string,
    private readonly onEnd?: () => void | Promise<void>,
    webSearchEnabled = false,
    reasoningEffort?: string,
    id = responseId(),
  ) {
    this.id = id
    this.decoder = new DeepSeekEventDecoder(Boolean(reasoningEffort), webSearchEnabled)
  }

  handleStream(stream: NodeJS.ReadableStream): NodeJS.ReadableStream {
    const source = stream as Readable
    const output = new PassThrough()
    let buffer = ''

    source.on('data', (chunk: Buffer | string) => {
      if (this.isDone) return
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data:')) continue
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

    source.once('end', () => this.finishStream(output))
    source.once('error', (error) => {
      if (!this.isDone) {
        this.isDone = true
        output.destroy(error)
      }
      this.cleanup()
    })
    output.once('close', () => {
      if (!this.isDone && !source.destroyed) source.destroy()
      this.cleanup()
    })

    return output
  }

  async handleNonStream(stream: NodeJS.ReadableStream): Promise<unknown> {
    let content = ''
    let reasoningContent = ''
    let providerError: DeepSeekProviderError | undefined

    try {
      let buffer = ''
      for await (const chunk of stream) {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data:')) continue
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
    } finally {
      await this.cleanup()
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
    this.cleanup()
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
    this.cleanup()
  }

  private async cleanup(): Promise<void> {
    if (this.cleanupStarted) return
    this.cleanupStarted = true
    try {
      await this.onEnd?.()
    } catch {
      // Cleanup is best effort and must not alter the client response.
    }
  }
}
