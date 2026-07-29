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

  it('rejects all remote media and accepts only canonical base64 images', () => {
    const request = (url: string) => ({
      model: 'test-model',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url } }],
      }],
    })

    expect(() => parseChatRequest(request('https://example.com/image.jpg'))).toThrow()
    expect(() => parseChatRequest(request('data:text/html;base64,PGgxPk5vPC9oMT4='))).toThrow()
    expect(() => parseChatRequest(request('data:image/png;base64,***'))).toThrow()
    expect(() => parseChatRequest(request('data:image/png;base64,aGVsbG8='))).toThrow()
    expect(parseChatRequest(request('data:image/png;base64,iVBORw0KGgo='))).toMatchObject({
      model: 'test-model',
    })
  })
})
