import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'

const confirmation = process.env.CHAT2API_LOAD_CONFIRM
const baseUrlInput = process.env.CHAT2API_BASE_URL
const apiKey = process.env.CHAT2API_API_KEY
const model = process.env.CHAT2API_LOAD_MODEL
const requestCount = Number(process.env.CHAT2API_LOAD_REQUESTS ?? 10)
const concurrency = Number(process.env.CHAT2API_LOAD_CONCURRENCY ?? 2)

if (confirmation !== 'I_UNDERSTAND_PROVIDER_TRAFFIC') {
  throw new Error('Set CHAT2API_LOAD_CONFIRM=I_UNDERSTAND_PROVIDER_TRAFFIC explicitly')
}
if (!baseUrlInput || !apiKey || !model) {
  throw new Error('CHAT2API_BASE_URL, CHAT2API_API_KEY and CHAT2API_LOAD_MODEL are required')
}
if (!Number.isInteger(requestCount) || requestCount < 1 || requestCount > 100) {
  throw new Error('CHAT2API_LOAD_REQUESTS must be an integer from 1 to 100')
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) {
  throw new Error('CHAT2API_LOAD_CONCURRENCY must be an integer from 1 to 10')
}

const baseUrl = new URL(baseUrlInput)
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('Load smoke requires HTTPS except for loopback development')
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('CHAT2API_BASE_URL must not contain credentials, query, or fragments')
}
const configuredPath = baseUrl.pathname.replace(/\/+$/, '')
const apiPath = configuredPath.endsWith('/v1') ? configuredPath : `${configuredPath}/v1`
const endpoint = new URL(`${apiPath}/chat/completions`, baseUrl).toString()
const latencies = []
const statuses = new Map()
let nextIndex = 0

async function worker() {
  while (nextIndex < requestCount) {
    const requestIndex = nextIndex
    nextIndex += 1
    const started = performance.now()
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: `Reply with exactly LOAD_OK_${requestIndex}.` }],
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    latencies.push(Math.round(performance.now() - started))
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1)
    if (response.status === 200) {
      const body = await response.json()
      assert.equal(typeof body?.choices?.[0]?.message?.content, 'string')
    } else {
      await response.arrayBuffer()
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requestCount) }, () => worker()))
latencies.sort((left, right) => left - right)
const percentile = (fraction) => latencies[Math.min(
  latencies.length - 1,
  Math.ceil(latencies.length * fraction) - 1,
)]
const failures = [...statuses.entries()]
  .filter(([status]) => status < 200 || status >= 300)
  .reduce((total, [, count]) => total + count, 0)

process.stdout.write(`${JSON.stringify({
  requests: requestCount,
  concurrency,
  successes: requestCount - failures,
  failures,
  statusCounts: Object.fromEntries([...statuses.entries()].sort()),
  latencyMs: {
    p50: percentile(0.5),
    p95: percentile(0.95),
    maximum: latencies.at(-1),
  },
}, null, 2)}\n`)

if (failures > 0) process.exitCode = 1
