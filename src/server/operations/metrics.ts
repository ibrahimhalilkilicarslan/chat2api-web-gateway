import type { OperationalMetrics } from '../../main/store/store.js'

export interface AccountStateCounts {
  total: number
  active: number
  error: number
  inactive: number
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')
}

function metricLine(name: string, value: number, labels?: Record<string, string>): string {
  const rendered = labels && Object.keys(labels).length > 0
    ? `{${Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`
    : ''
  return `${name}${rendered} ${Number.isFinite(value) ? value : 0}`
}

// Render the store's operational metrics plus provider-account state as a
// Prometheus text exposition. Only aggregates are emitted — never account ids,
// names, or credentials — so the surface is safe for a scrape target.
export function renderPrometheusMetrics(
  metrics: OperationalMetrics,
  accounts: AccountStateCounts,
): string {
  const out: string[] = []

  out.push('# HELP chat2api_up Gateway process is serving requests.')
  out.push('# TYPE chat2api_up gauge')
  out.push(metricLine('chat2api_up', 1))

  out.push('# HELP chat2api_requests Recent-window request count by status.')
  out.push('# TYPE chat2api_requests gauge')
  out.push(metricLine('chat2api_requests', metrics.status.success, { status: 'success' }))
  out.push(metricLine('chat2api_requests', metrics.status.error, { status: 'error' }))
  out.push(metricLine('chat2api_requests', metrics.status.pending, { status: 'pending' }))

  out.push('# HELP chat2api_request_sample_size Size of the recent-window sample.')
  out.push('# TYPE chat2api_request_sample_size gauge')
  out.push(metricLine('chat2api_request_sample_size', metrics.sampleSize))

  out.push('# HELP chat2api_request_latency_ms Recent-window request latency summary.')
  out.push('# TYPE chat2api_request_latency_ms gauge')
  out.push(metricLine('chat2api_request_latency_ms', metrics.latency.p50, { quantile: '0.5' }))
  out.push(metricLine('chat2api_request_latency_ms', metrics.latency.p95, { quantile: '0.95' }))
  out.push(metricLine('chat2api_request_latency_ms_average', metrics.latency.average))
  out.push(metricLine('chat2api_request_latency_ms_max', metrics.latency.maximum))

  out.push('# HELP chat2api_errors Recent-window errors by code.')
  out.push('# TYPE chat2api_errors gauge')
  for (const entry of metrics.errorsByCode) {
    out.push(metricLine('chat2api_errors', entry.count, { code: entry.code }))
  }

  out.push('# HELP chat2api_requests_by_model Recent-window requests by model.')
  out.push('# TYPE chat2api_requests_by_model gauge')
  for (const entry of metrics.usageByModel) {
    out.push(metricLine('chat2api_requests_by_model', entry.count, { model: entry.model }))
  }

  out.push('# HELP chat2api_accounts Provider account counts by state.')
  out.push('# TYPE chat2api_accounts gauge')
  out.push(metricLine('chat2api_accounts', accounts.total, { state: 'total' }))
  out.push(metricLine('chat2api_accounts', accounts.active, { state: 'active' }))
  out.push(metricLine('chat2api_accounts', accounts.error, { state: 'error' }))
  out.push(metricLine('chat2api_accounts', accounts.inactive, { state: 'inactive' }))

  return `${out.join('\n')}\n`
}
