import { describe, expect, it } from 'vitest'
import {
  CredentialVault,
  constantTimeEqual,
  generateApiKey,
  hashSecret,
} from './crypto.js'

describe('credential security', () => {
  it('encrypts credentials with authenticated encryption', () => {
    const vault = new CredentialVault(Buffer.alloc(32, 3))
    const credentials = { token: 'provider-secret-value', cookie: 'session-cookie' }
    const envelope = vault.encrypt(credentials)

    expect(envelope).toMatch(/^v1\./)
    expect(envelope).not.toContain(credentials.token)
    expect(vault.decrypt(envelope)).toEqual(credentials)
  })

  it('rejects a tampered credential envelope', () => {
    const vault = new CredentialVault(Buffer.alloc(32, 5))
    const envelope = vault.encrypt({ token: 'provider-secret-value' })
    const last = envelope.at(-1)
    const tampered = `${envelope.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`

    expect(() => vault.decrypt(tampered)).toThrow()
  })

  it('generates non-plaintext API key records', () => {
    const key = generateApiKey()

    expect(key).toMatch(/^c2a_[A-Za-z0-9_-]{40,}$/)
    expect(hashSecret(key)).not.toContain(key)
    expect(constantTimeEqual(key, key)).toBe(true)
    expect(constantTimeEqual(key, `${key}x`)).toBe(false)
  })
})
