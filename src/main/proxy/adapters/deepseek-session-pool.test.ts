import { describe, expect, it, vi } from 'vitest'
import { DeepSeekSessionPool } from './deepseek-session-pool.js'

describe('DeepSeekSessionPool', () => {
  it('reuses an idle session within its lease lifetime', async () => {
    let now = 1000
    let sequence = 0
    const create = vi.fn(async () => `session-${++sequence}`)
    const retire = vi.fn(async () => true)
    const pool = new DeepSeekSessionPool(() => now)

    const first = await pool.acquire('account', 300_000, create, retire)
    expect(first).toEqual({ sessionId: 'session-1', reused: false })
    expect(pool.release('account', first.sessionId)).toEqual({ found: true, retired: false })

    now += 60_000
    const second = await pool.acquire('account', 300_000, create, retire)
    expect(second).toEqual({ sessionId: 'session-1', reused: true })
    expect(create).toHaveBeenCalledTimes(1)
    expect(retire).not.toHaveBeenCalled()
    expect(pool.state()).toMatchObject({ active: 1, created: 1, reused: 1 })
  })

  it('never leases the same upstream session to concurrent requests', async () => {
    let sequence = 0
    const pool = new DeepSeekSessionPool(() => 1000)
    const create = vi.fn(async () => `session-${++sequence}`)
    const retire = vi.fn(async () => true)

    const [first, second] = await Promise.all([
      pool.acquire('account', 300_000, create, retire),
      pool.acquire('account', 300_000, create, retire),
    ])

    expect(first.sessionId).not.toBe(second.sessionId)
    expect(create).toHaveBeenCalledTimes(2)
    expect(pool.state()).toMatchObject({ active: 2, idle: 0 })
  })

  it('retires an expired idle session before creating its replacement', async () => {
    let now = 1000
    let sequence = 0
    const pool = new DeepSeekSessionPool(() => now)
    const create = vi.fn(async () => `session-${++sequence}`)
    const retire = vi.fn(async () => true)

    const first = await pool.acquire('account', 1000, create, retire)
    pool.release('account', first.sessionId)
    now += 1001
    const second = await pool.acquire('account', 1000, create, retire)

    expect(second).toEqual({ sessionId: 'session-2', reused: false })
    expect(retire).toHaveBeenCalledWith('session-1')
    expect(pool.state()).toMatchObject({ created: 2, retired: 1 })
  })

  it('removes invalid sessions without making them reusable', async () => {
    let sequence = 0
    const pool = new DeepSeekSessionPool(() => 1000)
    const create = vi.fn(async () => `session-${++sequence}`)
    const retire = vi.fn(async () => true)

    const first = await pool.acquire('account', 300_000, create, retire)
    expect(pool.invalidate('account', first.sessionId)).toBe(true)
    const second = await pool.acquire('account', 300_000, create, retire)

    expect(second.sessionId).toBe('session-2')
    expect(pool.state().invalidated).toBe(1)
  })
})
