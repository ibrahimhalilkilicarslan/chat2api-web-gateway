export interface AlertEvent {
  event: 'account_unhealthy' | 'account_recovered'
  provider: string
  accountId: string
  status?: string
  message?: string
  timestamp: string
}

interface AlertLogger {
  warn: (details: Record<string, unknown>, message: string) => void
}

// Best-effort outbound alert. Never throws and never blocks the caller for long
// so account-health processing is unaffected by a slow or unreachable webhook.
export async function dispatchAlert(
  webhookUrl: string | undefined,
  event: AlertEvent,
  log: AlertLogger,
): Promise<void> {
  if (!webhookUrl) return
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
    if (!response.ok) {
      log.warn({ statusCode: response.status }, 'alert webhook returned a non-2xx status')
    }
  } catch (error) {
    log.warn({ errorType: (error as Error).name }, 'alert webhook delivery failed')
  } finally {
    clearTimeout(timer)
  }
}
