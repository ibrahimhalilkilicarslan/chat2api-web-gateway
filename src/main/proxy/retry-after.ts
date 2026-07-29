const MAX_RETRY_AFTER_MS = 15 * 60_000

export function parseRetryAfterMs(value: unknown, now = Date.now()): number | undefined {
  const normalized = Array.isArray(value) ? value[0] : value
  if (typeof normalized !== 'string' && typeof normalized !== 'number') return undefined

  const text = String(normalized).trim()
  if (!text) return undefined

  let milliseconds: number
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    milliseconds = Math.ceil(Number(text) * 1000)
  } else {
    const retryAt = Date.parse(text)
    if (!Number.isFinite(retryAt)) return undefined
    milliseconds = Math.max(0, retryAt - now)
  }

  if (!Number.isFinite(milliseconds)) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, milliseconds))
}
