import { describe, expect, it } from 'vitest'
import type { OperationalMetrics } from '../../main/store/store.js'
import { renderPrometheusMetrics } from './metrics.js'

const metrics: OperationalMetrics = {
  sampleSize: 42,
  latency: { average: 120, p50: 100, p95: 300, maximum: 900 },
  status: { success: 40, error: 2, pending: 0 },
  errorsByCode: [{ code: 'provider_rate_limited', count: 2 }],
  usageByAccount: [{ accountId: 'secret-account-id', count: 30 }],
  usageByModel: [{ model: 'deepseek-v4-flash', count: 42 }],
  hourly: [],
}

describe('renderPrometheusMetrics', () => {
  const output = renderPrometheusMetrics(metrics, { total: 4, active: 3, error: 1, inactive: 0 })

  it('emits Prometheus lines for status, latency, and accounts', () => {
    expect(output).toContain('chat2api_up 1')
    expect(output).toContain('chat2api_requests{status="success"} 40')
    expect(output).toContain('chat2api_request_latency_ms{quantile="0.95"} 300')
    expect(output).toContain('chat2api_errors{code="provider_rate_limited"} 2')
    expect(output).toContain('chat2api_requests_by_model{model="deepseek-v4-flash"} 42')
    expect(output).toContain('chat2api_accounts{state="active"} 3')
    expect(output).toContain('chat2api_accounts{state="error"} 1')
  })

  it('never leaks account identifiers', () => {
    expect(output).not.toContain('secret-account-id')
  })
})
