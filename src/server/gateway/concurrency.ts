export class ConcurrencyGate {
  private active = 0

  constructor(private readonly limit: number) {}

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.limit) return undefined
    this.active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.active = Math.max(0, this.active - 1)
    }
  }

  getActive(): number {
    return this.active
  }

  getLimit(): number {
    return this.limit
  }
}
