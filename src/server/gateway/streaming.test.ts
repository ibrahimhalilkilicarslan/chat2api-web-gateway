import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enforceIdleTimeout, primeStream } from './streaming.js'

describe('stream lifecycle controls', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('primes the first byte without consuming the remaining stream', async () => {
    const source = Readable.from([Buffer.from('first'), Buffer.from('second')])
    const primed = await primeStream(source, 1000)
    let remainder = ''
    for await (const chunk of primed.stream) remainder += chunk.toString()

    expect(primed.firstChunk.toString()).toBe('first')
    expect(remainder).toBe('second')
  })

  it('fails when a stream ends before the first byte', async () => {
    await expect(primeStream(Readable.from([]), 1000)).rejects.toThrow(
      'ended before producing data',
    )
  })

  it('destroys an upstream stream after the configured idle interval', async () => {
    vi.useFakeTimers()
    const source = new PassThrough()
    const errors: Error[] = []
    source.on('error', (error) => errors.push(error))

    enforceIdleTimeout(source, 50)
    await vi.advanceTimersByTimeAsync(51)

    expect(source.destroyed).toBe(true)
    expect(errors[0]?.message).toBe('Upstream stream idle timeout')
  })
})
