import assert from 'node:assert/strict'

const baseUrlInput = process.env.CHAT2API_BASE_URL
const apiKey = process.env.CHAT2API_API_KEY
const model = process.env.CHAT2API_SMOKE_MODEL
const testStreaming = process.env.CHAT2API_SMOKE_STREAM === 'true'

if (!baseUrlInput || !apiKey) {
  throw new Error('CHAT2API_BASE_URL and CHAT2API_API_KEY are required')
}

const baseUrl = new URL(baseUrlInput)
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('Remote smoke requires HTTPS except for loopback development')
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('CHAT2API_BASE_URL must not contain credentials, query parameters, or fragments')
}
const configuredPath = baseUrl.pathname.replace(/\/+$/, '')
const usesExplicitApiPath = configuredPath.endsWith('/v1')
const servicePath = usesExplicitApiPath ? configuredPath.slice(0, -3) : configuredPath
const apiPath = usesExplicitApiPath ? configuredPath : `${configuredPath}/v1`

function endpoint(path, scope = 'service') {
  const prefix = scope === 'api' ? apiPath : servicePath
  return new URL(`${prefix}${path}`, baseUrl).toString()
}

async function request(path, init = {}, timeoutMs = 90_000, scope = 'service') {
  return fetch(endpoint(path, scope), {
    ...init,
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  })
}

function authorizedHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${apiKey}`,
    ...extra,
  }
}

const ready = await request('/health/ready')
assert.equal(ready.status, 200, `readiness returned ${ready.status}`)

const unauthenticatedModels = await request('/models', {}, 90_000, 'api')
assert.equal(unauthenticatedModels.status, 401, 'models endpoint is not fail-closed')

const modelsResponse = await request(
  '/models',
  {
    headers: authorizedHeaders(),
  },
  90_000,
  'api',
)
assert.equal(modelsResponse.status, 200, `authenticated models returned ${modelsResponse.status}`)
const models = await modelsResponse.json()
assert.ok(Array.isArray(models?.data), 'models response is not OpenAI-compatible')
if (model) {
  assert.ok(
    models.data.some((entry) => entry?.id === model),
    `configured smoke model is unavailable: ${model}`,
  )

  const completion = await request(
    '/chat/completions',
    {
      method: 'POST',
      headers: authorizedHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly REMOTE_OK.' }],
        stream: false,
      }),
    },
    90_000,
    'api',
  )
  assert.equal(completion.status, 200, `non-stream completion returned ${completion.status}`)
  const completionBody = await completion.json()
  const content = completionBody?.choices?.[0]?.message?.content
  assert.equal(typeof content, 'string', 'non-stream completion has no text content')
  assert.ok(content.trim().length > 0, 'non-stream completion returned empty content')

  if (testStreaming) {
    const stream = await request(
      '/chat/completions',
      {
        method: 'POST',
        headers: authorizedHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly STREAM_OK.' }],
          stream: true,
        }),
      },
      90_000,
      'api',
    )
    assert.equal(stream.status, 200, `stream completion returned ${stream.status}`)
    assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/i)
    const body = await stream.text()
    assert.ok(body.includes('data:'), 'stream returned no SSE events')
    assert.ok(body.includes('[DONE]'), 'stream did not terminate cleanly')
  }
}

process.stdout.write(
  `Remote smoke passed: readiness, auth boundary, models${model ? ', non-stream' : ''}${model && testStreaming ? ', stream' : ''}.\n`,
)
