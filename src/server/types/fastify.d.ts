import 'fastify'
import type { StoredApiKey } from '../../main/store/store.js'

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: StoredApiKey
    adminSession?: {
      nonce: string
      expiresAt: number
    }
  }
}
