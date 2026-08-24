import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

// Minimum passphrase length for an export. The bundle is only as strong as this
// secret, so a short passphrase is rejected up front.
export const MIN_EXPORT_PASSPHRASE = 12

export interface PortableAccount {
  providerId: string
  name: string
  email?: string
  credentials: Record<string, string>
}

export interface AccountExportBundle {
  format: 'chat2api-accounts-export'
  version: 1
  kdf: 'scrypt'
  salt: string
  iv: string
  authTag: string
  ciphertext: string
  count: number
  exportedAt: string
}

const SCRYPT_COST = 16384
const SCRYPT_BLOCK = 8
const SCRYPT_PARALLEL = 1

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
    maxmem: 64 * 1024 * 1024,
  })
}

// Encrypt the given accounts (including credentials) into a portable, passphrase
// protected bundle. The bundle is independent of the instance master key, so it
// can be imported into a fresh deployment with a different master key.
export function exportAccounts(
  accounts: readonly PortableAccount[],
  passphrase: string,
): AccountExportBundle {
  if (passphrase.length < MIN_EXPORT_PASSPHRASE) {
    throw new Error(`The passphrase must be at least ${MIN_EXPORT_PASSPHRASE} characters.`)
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const plaintext = Buffer.from(JSON.stringify(accounts), 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    format: 'chat2api-accounts-export',
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    count: accounts.length,
    exportedAt: new Date().toISOString(),
  }
}

function decodeField(value: unknown, field: string): Buffer {
  if (typeof value !== 'string') throw new Error(`Corrupt export bundle (${field}).`)
  const buffer = Buffer.from(value, 'base64')
  if (buffer.length === 0) throw new Error(`Corrupt export bundle (${field}).`)
  return buffer
}

// Decrypt and validate an export bundle back into portable accounts. Throws a
// user-safe error on a wrong passphrase, tampering, or an unsupported bundle.
export function importAccounts(bundle: unknown, passphrase: string): PortableAccount[] {
  if (!bundle || typeof bundle !== 'object') throw new Error('The export bundle is invalid.')
  const record = bundle as Partial<AccountExportBundle>
  if (record.format !== 'chat2api-accounts-export' || record.version !== 1 || record.kdf !== 'scrypt') {
    throw new Error('This file is not a supported chat2api account export.')
  }

  const salt = decodeField(record.salt, 'salt')
  const iv = decodeField(record.iv, 'iv')
  const authTag = decodeField(record.authTag, 'authTag')
  const ciphertext = decodeField(record.ciphertext, 'ciphertext')

  const key = deriveKey(passphrase, salt)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  let plaintext: Buffer
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch {
    throw new Error('Wrong passphrase, or the export file has been altered.')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext.toString('utf8'))
  } catch {
    throw new Error('The export contents are corrupt.')
  }
  if (!Array.isArray(parsed)) throw new Error('The export contents are invalid.')

  return parsed.map((entry) => {
    if (
      !entry
      || typeof entry !== 'object'
      || typeof (entry as PortableAccount).providerId !== 'string'
      || typeof (entry as PortableAccount).name !== 'string'
      || typeof (entry as PortableAccount).credentials !== 'object'
      || (entry as PortableAccount).credentials === null
    ) {
      throw new Error('The export contains an invalid account entry.')
    }
    const account = entry as PortableAccount
    return {
      providerId: account.providerId,
      name: account.name,
      email: typeof account.email === 'string' ? account.email : undefined,
      credentials: account.credentials,
    }
  })
}
