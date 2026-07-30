import { describe, expect, it } from 'vitest'
import { DeepSeekLinkSessionRegistry } from './deepseek-link-session.js'

describe('DeepSeekLinkSessionRegistry', () => {
  it('binds admin reads to the creating session and never exposes the secret', () => {
    const registry = new DeepSeekLinkSessionRegistry()
    const created = registry.create({
      ownerNonce: 'admin-session-a',
      name: 'Dedicated account',
      now: 1_000,
    })

    expect(created.secrets.native.length).toBeGreaterThan(30)
    expect(created.secrets['browser-extension'].length).toBeGreaterThan(30)
    expect(created.secrets.native).not.toBe(created.secrets['browser-extension'])
    expect(registry.read(created.session.id, 'admin-session-a', 1_001)).toMatchObject({
      status: 'waiting',
    })
    expect(registry.read(created.session.id, 'admin-session-b', 1_001)).toBeUndefined()
    expect(JSON.stringify(created.session)).not.toContain(created.secrets.native)
    expect(JSON.stringify(created.session)).not.toContain(created.secrets['browser-extension'])
  })

  it('accepts a capability once, serializes validation and supports idempotent completion', () => {
    const registry = new DeepSeekLinkSessionRegistry()
    const created = registry.create({
      ownerNonce: 'admin-session',
      name: 'Dedicated account',
      email: 'account@example.com',
      dailyLimit: 500,
      now: 2_000,
    })

    expect(registry.claim(
      created.session.id,
      'wrong-secret',
      'browser-extension',
      2_001,
    )).toBeUndefined()
    expect(registry.claim(
      created.session.id,
      created.secrets['browser-extension'],
      'browser-extension',
      2_001,
    )).toMatchObject({
      kind: 'ready',
      name: 'Dedicated account',
      email: 'account@example.com',
      dailyLimit: 500,
    })
    expect(registry.claim(
      created.session.id,
      created.secrets.native,
      'native',
      2_002,
    )).toMatchObject({
      kind: 'busy',
    })

    registry.complete(created.session.id, 'account-id')
    expect(registry.claim(
      created.session.id,
      created.secrets.native,
      'native',
      2_003,
    )).toMatchObject({
      kind: 'complete',
      accountId: 'account-id',
    })
  })

  it('returns failed validation to waiting state and expires short-lived sessions', () => {
    const registry = new DeepSeekLinkSessionRegistry()
    const created = registry.create({
      ownerNonce: 'admin-session',
      name: 'Dedicated account',
      now: 3_000,
    })

    registry.claim(
      created.session.id,
      created.secrets.native,
      'native',
      3_001,
    )
    registry.fail(created.session.id, 'provider_authentication_failed', 'Session is invalid.')
    expect(registry.read(created.session.id, 'admin-session', 3_002)).toMatchObject({
      status: 'waiting',
      errorCode: 'provider_authentication_failed',
      errorMessage: 'Session is invalid.',
    })
    expect(registry.read(created.session.id, 'admin-session', created.session.expiresAt)).toMatchObject({
      status: 'expired',
    })
    expect(registry.claim(
      created.session.id,
      created.secrets.native,
      'native',
      created.session.expiresAt,
    )).toBeUndefined()
  })

  it('keeps native and browser-extension capabilities transport-bound', () => {
    const registry = new DeepSeekLinkSessionRegistry()
    const created = registry.create({
      ownerNonce: 'admin-session',
      name: 'Dedicated account',
      now: 4_000,
    })

    expect(registry.claim(
      created.session.id,
      created.secrets.native,
      'browser-extension',
      4_001,
    )).toBeUndefined()
    expect(registry.claim(
      created.session.id,
      created.secrets['browser-extension'],
      'native',
      4_001,
    )).toBeUndefined()
    expect(registry.claim(
      created.session.id,
      created.secrets.native,
      'native',
      4_001,
    )).toMatchObject({ kind: 'ready' })
  })
})
