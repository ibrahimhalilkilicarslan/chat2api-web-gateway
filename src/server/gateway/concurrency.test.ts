import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConcurrencyGate } from './concurrency.js'

describe('ConcurrencyGate', () => {
  afterEach(() => vi.useRealTimers())

  it('queues a request until capacity is released', async () => {
    const gate = new ConcurrencyGate(1, 10, 1000)
    const firstRelease = gate.tryAcquire()
    expect(firstRelease).toBeTypeOf('function')

    const waiting = gate.acquire()
    expect(gate.getQueued()).toBe(1)
    firstRelease?.()

    const secondRelease = await waiting
    expect(secondRelease).toBeTypeOf('function')
    expect(gate.getQueued()).toBe(0)
    expect(gate.getActive()).toBe(1)
    secondRelease?.()
  })

  it('runs foreground work before queued background work', async () => {
    const gate = new ConcurrencyGate(1, 10, 1000)
    const firstRelease = gate.tryAcquire()
    const order: string[] = []
    const background = gate.acquire({ priority: 'background' }).then((release) => {
      order.push('background')
      return release
    })
    const foreground = gate.acquire({ priority: 'foreground' }).then((release) => {
      order.push('foreground')
      return release
    })

    firstRelease?.()
    const foregroundRelease = await foreground
    expect(order).toEqual(['foreground'])
    foregroundRelease?.()
    const backgroundRelease = await background
    expect(order).toEqual(['foreground', 'background'])
    backgroundRelease?.()
  })

  it('removes timed-out and aborted waiters without leaking capacity', async () => {
    vi.useFakeTimers()
    const gate = new ConcurrencyGate(1, 10, 1000)
    const firstRelease = gate.tryAcquire()
    const timedOut = gate.acquire({ timeoutMs: 50 })
    const controller = new AbortController()
    const aborted = gate.acquire({ signal: controller.signal })

    controller.abort()
    await vi.advanceTimersByTimeAsync(50)

    await expect(aborted).resolves.toBeUndefined()
    await expect(timedOut).resolves.toBeUndefined()
    expect(gate.getQueued()).toBe(0)
    firstRelease?.()
    expect(gate.getActive()).toBe(0)
  })
})
