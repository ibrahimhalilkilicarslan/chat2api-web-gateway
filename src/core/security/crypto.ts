import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const VAULT_VERSION = 'v1'
const VAULT_AAD = Buffer.from('chat2api:provider-credentials:v1', 'utf8')

export class CredentialVault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error('CredentialVault requires a 32-byte key')
    }
  }

  encrypt(value: unknown): string {
    const initializationVector = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, initializationVector)
    cipher.setAAD(VAULT_AAD)

    const plaintext = Buffer.from(JSON.stringify(value), 'utf8')
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const authenticationTag = cipher.getAuthTag()

    return [
      VAULT_VERSION,
      initializationVector.toString('base64url'),
      authenticationTag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.')
  }

  decrypt<T>(envelope: string): T {
    const [version, ivValue, tagValue, ciphertextValue, extra] = envelope.split('.')
    if (
      version !== VAULT_VERSION
      || !ivValue
      || !tagValue
      || !ciphertextValue
      || extra !== undefined
    ) {
      throw new Error('Unsupported or malformed credential envelope')
    }

    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'))
    decipher.setAAD(VAULT_AAD)
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))

    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ])
    return JSON.parse(plaintext.toString('utf8')) as T
  }
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function secretPrefix(value: string): string {
  return value.slice(0, Math.min(12, value.length))
}

export function generateApiKey(): string {
  return `c2a_${randomBytes(32).toString('base64url')}`
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest()
  const rightDigest = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

export function signValue(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('base64url')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
