import { describe, expect, it } from 'vitest'
import {
  exportAccounts,
  importAccounts,
  type PortableAccount,
} from './accountTransfer.js'

const accounts: PortableAccount[] = [
  { providerId: 'deepseek', name: 'primary', credentials: { token: 'secret-token-1' } },
  { providerId: 'deepseek', name: 'backup', email: 'ops@example.com', credentials: { token: 'secret-token-2' } },
]

describe('account export/import', () => {
  it('round-trips accounts through an encrypted bundle', () => {
    const bundle = exportAccounts(accounts, 'correct horse battery')
    expect(bundle.format).toBe('chat2api-accounts-export')
    expect(bundle.count).toBe(2)
    // Ciphertext must not leak the plaintext tokens.
    expect(JSON.stringify(bundle)).not.toContain('secret-token-1')

    const restored = importAccounts(bundle, 'correct horse battery')
    expect(restored).toEqual(accounts)
  })

  it('rejects a short passphrase on export', () => {
    expect(() => exportAccounts(accounts, 'short')).toThrow(/at least/)
  })

  it('rejects a wrong passphrase on import', () => {
    const bundle = exportAccounts(accounts, 'correct horse battery')
    expect(() => importAccounts(bundle, 'wrong passphrase here')).toThrow(/Wrong passphrase/)
  })

  it('rejects a tampered bundle', () => {
    const bundle = exportAccounts(accounts, 'correct horse battery')
    const tampered = { ...bundle, ciphertext: Buffer.from('tampered-data').toString('base64') }
    expect(() => importAccounts(tampered, 'correct horse battery')).toThrow()
  })

  it('rejects an unsupported bundle', () => {
    expect(() => importAccounts({ format: 'other', version: 1 }, 'correct horse battery'))
      .toThrow(/not a supported/)
    expect(() => importAccounts(null, 'correct horse battery')).toThrow(/invalid/)
  })
})
