import type { StoredApiKey } from '../../main/store/store.js'

interface WindowState {
  timestamps: number[]
}

export interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
}

export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, WindowState>()
  private readonly windowMs = 60_000

  consume(record: StoredApiKey, now = Date.now()): RateLimitResult {
    const cutoff = now - this.windowMs
    const state = this.windows.get(record.id) ?? { timestamps: [] }
    const timestamps = state.timestamps.filter((timestamp) => timestamp > cutoff)
    const resetAt = timestamps[0] ? timestamps[0] + this.windowMs : now + this.windowMs

    if (timestamps.length >= record.requestsPerMinute) {
      this.windows.set(record.id, { timestamps })
      return {
        allowed: false,
        limit: record.requestsPerMinute,
        remaining: 0,
        resetAt,
      }
    }

    timestamps.push(now)
    this.windows.set(record.id, { timestamps })
    return {
      allowed: true,
      limit: record.requestsPerMinute,
      remaining: Math.max(0, record.requestsPerMinute - timestamps.length),
      resetAt: (timestamps[0] ?? now) + this.windowMs,
    }
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs
    for (const [key, state] of this.windows) {
      const timestamps = state.timestamps.filter((timestamp) => timestamp > cutoff)
      if (timestamps.length === 0) this.windows.delete(key)
      else this.windows.set(key, { timestamps })
    }
  }
}
