import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  DeepSeekProviderError,
  DeepSeekStreamHandler,
  providerErrorFromJsonResponse,
} from './deepseek-stream.ts'

function providerStream(...events: unknown[]): Readable {
  const payload = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return Readable.from([`${payload}data: [DONE]\n\n`])
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ''
  for await (const chunk of stream) output += chunk.toString()
  return output
}

describe('DeepSeekStreamHandler', () => {
  it('maps a muted JSON envelope to an explicit provider suspension', () => {
    const error = providerErrorFromJsonResponse(JSON.stringify({
      code: 0,
      data: {
        biz_code: 5,
        biz_msg: 'user is muted',
        biz_data: {
          is_muted: true,
          mute_until: Date.now() / 1000 + 60,
        },
      },
    }))

    expect(error).toMatchObject<DeepSeekProviderError>({
      name: 'DeepSeekProviderError',
      code: 'provider_account_suspended',
      status: 403,
      message: 'The DeepSeek account is temporarily suspended by the provider.',
    })
    expect(error?.retryAfterMs).toBeGreaterThan(50_000)
  })

  it('rejects a non-stream JSON suspension instead of reporting empty output', async () => {
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash')
    const stream = Readable.from([JSON.stringify({
      code: 0,
      data: {
        biz_code: 5,
        biz_msg: 'user is muted',
        biz_data: { is_muted: 1 },
      },
    })])

    await expect(handler.handleNonStream(stream)).rejects.toMatchObject({
      code: 'provider_account_suspended',
      status: 403,
    })
  })

  it('emits a sanitized suspension error for a streaming JSON envelope', async () => {
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash')
    const stream = Readable.from([JSON.stringify({
      code: 0,
      data: {
        biz_code: 5,
        biz_msg: 'user is muted',
        biz_data: { is_muted: 1, internal_note: 'must-not-leak' },
      },
    })])
    const output = await readStream(handler.handleStream(stream))

    expect(output).toContain('"code":"provider_account_suspended"')
    expect(output).toContain('data: [DONE]')
    expect(output).not.toContain('must-not-leak')
    expect(output).not.toContain('user is muted')
  })

  it('rejects non-stream requests when DeepSeek embeds a rate limit error in HTTP 200', async () => {
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash')
    const stream = providerStream({
      type: 'error',
      content: 'provider message',
      finish_reason: 'rate_limit_reached',
      clear_response: true,
    })

    await expect(handler.handleNonStream(stream)).rejects.toMatchObject<DeepSeekProviderError>({
      name: 'DeepSeekProviderError',
      code: 'provider_rate_limited',
      status: 429,
      message: 'DeepSeek rate limit reached. Retry later.',
    })
  })

  it('emits an OpenAI-compatible SSE error instead of an empty completion', async () => {
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash')
    const transformed = await handler.handleStream(providerStream({
      type: 'error',
      content: 'provider message',
      finish_reason: 'rate_limit_reached',
      clear_response: true,
    }))
    const output = await readStream(transformed)

    expect(output).toContain('"type":"provider_error"')
    expect(output).toContain('"code":"provider_rate_limited"')
    expect(output).toContain('data: [DONE]')
    expect(output).not.toContain('"finish_reason":"stop"')
    expect(output).not.toContain('provider message')
  })

  it('preserves successful answer fragments', async () => {
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash')
    const transformed = await handler.handleStream(providerStream({
      p: 'response/fragments',
      v: [{ type: 'ANSWER', content: 'API_OK' }],
    }))
    const output = await readStream(transformed)

    expect(output).toContain('"content":"API_OK"')
    expect(output).toContain('"finish_reason":"stop"')
    expect(output).toContain('data: [DONE]')
  })

  it('emits an opaque gateway response ID and never exposes an upstream session ID', async () => {
    const upstreamSessionId = 'upstream-session-that-must-not-leak'
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash')
    const output = await readStream(handler.handleStream(providerStream({
      p: 'response/fragments',
      v: [{ type: 'ANSWER', content: 'ok' }],
      session_id: upstreamSessionId,
    })))

    expect(output).toMatch(/"id":"chatcmpl-[a-f0-9]+"/)
    expect(output).not.toContain(upstreamSessionId)
    expect(output).not.toContain('"usage"')
  })

  it('returns an explicit provider error for an empty stream and cleans up once', async () => {
    const cleanup = vi.fn(async () => undefined)
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash', cleanup)
    const output = await readStream(handler.handleStream(providerStream()))

    expect(output).toContain('"code":"provider_empty_response"')
    expect(output).not.toContain('"finish_reason":"stop"')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('sanitizes citations and drops URLs containing embedded credentials', async () => {
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash', undefined, true)
    const result = await handler.handleNonStream(providerStream(
      {
        p: 'response/search_results',
        v: [
          {
            url: 'https://example.com/source',
            title: 'Safe [source]\nlabel',
            cite_index: 1,
          },
          {
            url: 'https://user:password@example.com/private',
            title: 'Credential URL',
            cite_index: 2,
          },
          {
            url: 'javascript:alert(1)',
            title: 'Unsafe scheme',
            cite_index: 3,
          },
        ],
      },
      {
        p: 'response/fragments',
        v: [{ type: 'ANSWER', content: 'Answer [citation:1]' }],
      },
    )) as {
      choices: Array<{ message: { content: string } }>
    }

    const content = result.choices[0]?.message.content
    expect(content).toContain('Answer [1]')
    expect(content).toContain('[Safe source label](https://example.com/source)')
    expect(content).not.toContain('password')
    expect(content).not.toContain('javascript:')
  })
})
