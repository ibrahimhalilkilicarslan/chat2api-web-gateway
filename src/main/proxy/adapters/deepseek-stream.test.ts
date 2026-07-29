import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DeepSeekProviderError,
  DeepSeekStreamHandler,
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
  it('rejects non-stream requests when DeepSeek embeds a rate limit error in HTTP 200', async () => {
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'session-id')
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
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'session-id')
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
    const handler = new DeepSeekStreamHandler('deepseek-v4-flash', 'session-id')
    const transformed = await handler.handleStream(providerStream({
      p: 'response/fragments',
      v: [{ type: 'ANSWER', content: 'API_OK' }],
    }))
    const output = await readStream(transformed)

    expect(output).toContain('"content":"API_OK"')
    expect(output).toContain('"finish_reason":"stop"')
    expect(output).toContain('data: [DONE]')
  })
})
