import type { RequestPriority } from '../../main/proxy/types.js'

interface AcquireOptions {
  priority?: RequestPriority
  signal?: AbortSignal
  timeoutMs?: number
}

interface Waiter {
  priority: RequestPriority
  signal?: AbortSignal
  resolve: (release: (() => void) | undefined) => void
  timeout?: NodeJS.Timeout
  abort?: () => void
}

export class ConcurrencyGate {
  private active = 0
  private readonly foreground: Waiter[] = []
  private readonly background: Waiter[] = []

  constructor(
    private readonly limit: number,
    private readonly maxQueue = 100,
    private readonly defaultTimeoutMs = 60_000,
  ) {}

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.limit || this.getQueued() > 0) return undefined
    this.active += 1
    return this.createRelease()
  }

  async acquire(options: AcquireOptions = {}): Promise<(() => void) | undefined> {
    const immediate = this.tryAcquire()
    if (immediate) return immediate
    if (options.signal?.aborted || this.getQueued() >= this.maxQueue) return undefined

    return new Promise((resolve) => {
      const waiter: Waiter = {
        priority: options.priority ?? 'foreground',
        signal: options.signal,
        resolve,
      }
      const queue = waiter.priority === 'foreground' ? this.foreground : this.background
      queue.push(waiter)

      const settleUnavailable = () => {
        if (!this.remove(waiter)) return
        this.cleanup(waiter)
        resolve(undefined)
      }
      const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(settleUnavailable, timeoutMs)
        waiter.timeout.unref()
      }
      if (options.signal) {
        waiter.abort = settleUnavailable
        options.signal.addEventListener('abort', waiter.abort, { once: true })
      }
    })
  }

  getActive(): number {
    return this.active
  }

  getQueued(): number {
    return this.foreground.length + this.background.length
  }

  getQueueState(): { foreground: number; background: number } {
    return {
      foreground: this.foreground.length,
      background: this.background.length,
    }
  }

  getLimit(): number {
    return this.limit
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
      this.drain()
    }
  }

  private drain(): void {
    while (this.active < this.limit) {
      const waiter = this.foreground.shift() ?? this.background.shift()
      if (!waiter) return
      this.cleanup(waiter)
      if (waiter.signal?.aborted) {
        waiter.resolve(undefined)
        continue
      }
      this.active += 1
      waiter.resolve(this.createRelease())
    }
  }

  private remove(waiter: Waiter): boolean {
    const queue = waiter.priority === 'foreground' ? this.foreground : this.background
    const index = queue.indexOf(waiter)
    if (index < 0) return false
    queue.splice(index, 1)
    return true
  }

  private cleanup(waiter: Waiter): void {
    if (waiter.timeout) clearTimeout(waiter.timeout)
    if (waiter.signal && waiter.abort) {
      waiter.signal.removeEventListener('abort', waiter.abort)
    }
  }
}
