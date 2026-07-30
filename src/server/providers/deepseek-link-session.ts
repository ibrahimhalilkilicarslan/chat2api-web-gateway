import { randomUUID } from 'node:crypto'
import { constantTimeEqual, hashSecret, randomToken } from '../../core/security/crypto.js'

const LINK_LIFETIME_MS = 10 * 60_000
const MAX_PENDING_LINKS = 100

export type DeepSeekLinkStatus = 'waiting' | 'validating' | 'complete' | 'cancelled'
export type DeepSeekLinkTransport = 'browser-extension' | 'native'

interface DeepSeekLinkRecord {
  id: string
  secretHashes: Record<DeepSeekLinkTransport, string>
  ownerNonce: string
  name: string
  email?: string
  dailyLimit?: number
  status: DeepSeekLinkStatus
  createdAt: number
  expiresAt: number
  accountId?: string
  errorCode?: string
  errorMessage?: string
}

export interface DeepSeekLinkView {
  id: string
  status: DeepSeekLinkStatus | 'expired'
  createdAt: number
  expiresAt: number
  accountId?: string
  errorCode?: string
  errorMessage?: string
}

export interface DeepSeekLinkClaim {
  kind: 'ready' | 'busy' | 'complete'
  id: string
  name: string
  email?: string
  dailyLimit?: number
  accountId?: string
}

export class DeepSeekLinkSessionRegistry {
  private readonly sessions = new Map<string, DeepSeekLinkRecord>()

  create(input: {
    ownerNonce: string
    name: string
    email?: string
    dailyLimit?: number
    now?: number
  }): {
    session: DeepSeekLinkView
    secrets: Record<DeepSeekLinkTransport, string>
  } {
    const now = input.now ?? Date.now()
    this.purge(now)
    if (this.sessions.size >= MAX_PENDING_LINKS) {
      const oldest = [...this.sessions.values()].sort((left, right) => left.createdAt - right.createdAt)[0]
      if (oldest) this.sessions.delete(oldest.id)
    }

    const id = randomUUID()
    const secrets = {
      'browser-extension': randomToken(32),
      native: randomToken(32),
    }
    const record: DeepSeekLinkRecord = {
      id,
      secretHashes: {
        'browser-extension': hashSecret(secrets['browser-extension']),
        native: hashSecret(secrets.native),
      },
      ownerNonce: input.ownerNonce,
      name: input.name,
      email: input.email,
      dailyLimit: input.dailyLimit,
      status: 'waiting',
      createdAt: now,
      expiresAt: now + LINK_LIFETIME_MS,
    }
    this.sessions.set(id, record)
    return { session: this.toView(record, now), secrets }
  }

  read(id: string, ownerNonce: string, now = Date.now()): DeepSeekLinkView | undefined {
    const record = this.sessions.get(id)
    if (!record || !constantTimeEqual(record.ownerNonce, ownerNonce)) return undefined
    return this.toView(record, now)
  }

  claim(
    id: string,
    secret: string,
    transport: DeepSeekLinkTransport,
    now = Date.now(),
  ): DeepSeekLinkClaim | undefined {
    const record = this.sessions.get(id)
    if (
      !record
      || record.expiresAt <= now
      || !constantTimeEqual(record.secretHashes[transport], hashSecret(secret))
      || record.status === 'cancelled'
    ) {
      return undefined
    }
    if (record.status === 'complete') {
      return {
        kind: 'complete',
        id: record.id,
        name: record.name,
        email: record.email,
        dailyLimit: record.dailyLimit,
        accountId: record.accountId,
      }
    }
    if (record.status === 'validating') {
      return {
        kind: 'busy',
        id: record.id,
        name: record.name,
        email: record.email,
        dailyLimit: record.dailyLimit,
      }
    }

    record.status = 'validating'
    record.errorCode = undefined
    record.errorMessage = undefined
    return {
      kind: 'ready',
      id: record.id,
      name: record.name,
      email: record.email,
      dailyLimit: record.dailyLimit,
    }
  }

  fail(id: string, errorCode: string, errorMessage: string): void {
    const record = this.sessions.get(id)
    if (!record || record.status !== 'validating') return
    record.status = 'waiting'
    record.errorCode = errorCode
    record.errorMessage = errorMessage
  }

  complete(id: string, accountId: string): void {
    const record = this.sessions.get(id)
    if (!record || record.status !== 'validating') return
    record.status = 'complete'
    record.accountId = accountId
    record.errorCode = undefined
    record.errorMessage = undefined
  }

  cancel(id: string, ownerNonce: string): boolean {
    const record = this.sessions.get(id)
    if (
      !record
      || !constantTimeEqual(record.ownerNonce, ownerNonce)
      || record.status === 'complete'
    ) {
      return false
    }
    record.status = 'cancelled'
    return true
  }

  clear(): void {
    this.sessions.clear()
  }

  private purge(now: number): void {
    for (const [id, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(id)
    }
  }

  private toView(record: DeepSeekLinkRecord, now: number): DeepSeekLinkView {
    return {
      id: record.id,
      status: record.expiresAt <= now ? 'expired' : record.status,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      accountId: record.accountId,
      errorCode: record.errorCode,
      errorMessage: record.errorMessage,
    }
  }
}
