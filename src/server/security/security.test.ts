import { describe, expect, it } from 'vitest'
import type { StoredApiKey } from '../../main/store/store.js'
import { ConcurrencyGate } from '../gateway/concurrency.js'
import { parseChatRequest } from '../schemas/chat.js'
import { SlidingWindowRateLimiter } from './rate-limiter.js'

function apiKey(limit: number): StoredApiKey {
  return {
    id: 'key-1',
    name: 'Test key',
    keyHash: 'hash',
    keyPrefix: 'prefix',
    scopes: ['chat'],
    modelAllowlist: [],
    requestsPerMinute: limit,
    dailyQuota: 100,
    enabled: true,
    managedByEnvironment: false,
    usageCount: 0,
    createdAt: 0,
  }
}

describe('gateway safety controls', () => {
  it('enforces sliding-window request limits', () => {
    const limiter = new SlidingWindowRateLimiter()
    const record = apiKey(2)

    expect(limiter.consume(record, 1_000).allowed).toBe(true)
    expect(limiter.consume(record, 2_000).allowed).toBe(true)
    expect(limiter.consume(record, 3_000).allowed).toBe(false)
    expect(limiter.consume(record, 62_000).allowed).toBe(true)
  })

  it('isolates rate-limit windows by API scope', () => {
    const limiter = new SlidingWindowRateLimiter()
    const record = apiKey(2)

    expect(limiter.consume(record, 1_000, 'models').allowed).toBe(true)
    expect(limiter.consume(record, 2_000, 'models').allowed).toBe(true)
    expect(limiter.consume(record, 3_000, 'models').allowed).toBe(false)
    expect(limiter.consume(record, 3_000, 'chat').allowed).toBe(true)
  })

  it('releases concurrency permits exactly once', () => {
    const gate = new ConcurrencyGate(1)
    const release = gate.tryAcquire()

    expect(release).toBeTypeOf('function')
    expect(gate.tryAcquire()).toBeUndefined()
    release?.()
    release?.()
    expect(gate.getActive()).toBe(0)
    expect(gate.tryAcquire()).toBeTypeOf('function')
  })

  it('accepts bounded inline media while rejecting remote media and unknown fields', () => {
    const request = (content: unknown, extra: Record<string, unknown> = {}) => ({
      model: 'test-model',
      messages: [{
        role: 'user',
        content,
      }],
      ...extra,
    })

    expect(parseChatRequest(request('hello'))).toMatchObject({
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
    })
    expect(parseChatRequest(request([
      { type: 'text', text: 'Inspect this receipt.' },
      {
        type: 'file',
        file: {
          filename: 'receipt.pdf',
          file_data: 'data:application/pdf;base64,JVBERi0xLjQKJSVFT0Y=',
        },
      },
    ]))).toMatchObject({
      messages: [{ role: 'user', content: expect.any(Array) }],
    })
    expect(() => parseChatRequest(request([
      { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
    ]))).toThrow()
    expect(() => parseChatRequest(request([
      {
        type: 'file',
        file: {
          filename: 'payload.svg',
          file_data: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
        },
      },
    ]))).toThrow()
    // Standard OpenAI fields are accepted for drop-in compatibility, and any
    // further unknown field is stripped rather than rejected.
    expect(() => parseChatRequest(request('hello', { tools: [] }))).not.toThrow()
    expect(() => parseChatRequest(request('hello', { temperature: 0.5 }))).not.toThrow()
    expect(() => parseChatRequest(request('hello', { some_future_field: true }))).not.toThrow()
  })
})
