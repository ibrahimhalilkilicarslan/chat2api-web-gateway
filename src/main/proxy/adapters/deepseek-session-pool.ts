export interface DeepSeekSessionLease {
  sessionId: string
  reused: boolean
}

export interface DeepSeekSessionPoolState {
  active: number
  idle: number
  created: number
  reused: number
  retired: number
  invalidated: number
}

interface SessionEntry {
  sessionId: string
  expiresAt: number
  inUse: boolean
}

interface ReleaseResult {
  found: boolean
  retired: boolean
}

export class DeepSeekSessionPool {
  private readonly sessions = new Map<string, SessionEntry[]>()
  private readonly operations = new Map<string, Promise<void>>()
  private created = 0
  private reused = 0
  private retired = 0
  private invalidated = 0

  constructor(private readonly now: () => number = Date.now) {}

  async acquire(
    key: string,
    ttlMs: number,
    create: () => Promise<string>,
    retire: (sessionId: string) => Promise<unknown>,
  ): Promise<DeepSeekSessionLease> {
    return this.serialize(key, async () => {
      const currentTime = this.now()
      const existing = this.sessions.get(key) ?? []
      const expired = existing.filter(
        (entry) => !entry.inUse && entry.expiresAt <= currentTime,
      )
      const available = existing.filter(
        (entry) => entry.inUse || entry.expiresAt > currentTime,
      )

      if (available.length > 0) this.sessions.set(key, available)
      else this.sessions.delete(key)

      for (const entry of expired) {
        this.retired += 1
        await retire(entry.sessionId).catch(() => undefined)
      }

      const reusable = available.find((entry) => !entry.inUse)
      if (reusable) {
        reusable.inUse = true
        this.reused += 1
        return { sessionId: reusable.sessionId, reused: true }
      }

      const sessionId = await create()
      const entry: SessionEntry = {
        sessionId,
        expiresAt: currentTime + Math.max(0, ttlMs),
        inUse: true,
      }
      const entries = this.sessions.get(key) ?? []
      entries.push(entry)
      this.sessions.set(key, entries)
      this.created += 1
      return { sessionId, reused: false }
    })
  }

  release(key: string, sessionId: string): ReleaseResult {
    const entries = this.sessions.get(key)
    const entry = entries?.find((candidate) => candidate.sessionId === sessionId)
    if (!entries || !entry) return { found: false, retired: false }

    entry.inUse = false
    if (entry.expiresAt > this.now()) return { found: true, retired: false }

    this.removeEntry(key, entries, entry)
    this.retired += 1
    return { found: true, retired: true }
  }

  invalidate(key: string, sessionId: string): boolean {
    const entries = this.sessions.get(key)
    const entry = entries?.find((candidate) => candidate.sessionId === sessionId)
    if (!entries || !entry) return false

    this.removeEntry(key, entries, entry)
    this.invalidated += 1
    return true
  }

  state(): DeepSeekSessionPoolState {
    const entries = [...this.sessions.values()].flat()
    return {
      active: entries.filter((entry) => entry.inUse).length,
      idle: entries.filter((entry) => !entry.inUse).length,
      created: this.created,
      reused: this.reused,
      retired: this.retired,
      invalidated: this.invalidated,
    }
  }

  clear(): void {
    this.sessions.clear()
    this.operations.clear()
    this.created = 0
    this.reused = 0
    this.retired = 0
    this.invalidated = 0
  }

  private removeEntry(key: string, entries: SessionEntry[], entry: SessionEntry): void {
    const remaining = entries.filter((candidate) => candidate !== entry)
    if (remaining.length > 0) this.sessions.set(key, remaining)
    else this.sessions.delete(key)
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.catch(() => undefined).then(() => current)
    this.operations.set(key, tail)

    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.operations.get(key) === tail) this.operations.delete(key)
    }
  }
}
