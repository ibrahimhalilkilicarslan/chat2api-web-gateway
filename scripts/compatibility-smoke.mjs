import assert from 'node:assert/strict'

const baseUrlInput = process.env.CHAT2API_BASE_URL
const apiKey = process.env.CHAT2API_API_KEY
const model = process.env.CHAT2API_SMOKE_MODEL

if (!baseUrlInput || !apiKey) {
  throw new Error('CHAT2API_BASE_URL and CHAT2API_API_KEY are required')
}

const baseUrl = new URL(baseUrlInput)
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
if (baseUrl.protocol !== 'https:' && !(baseUrl.protocol === 'http:' && isLoopback)) {
  throw new Error('Compatibility smoke requires HTTPS except for loopback development')
}
if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('CHAT2API_BASE_URL must not contain credentials, query, or fragments')
}

const configuredPath = baseUrl.pathname.replace(/\/+$/, '')
const apiPath = configuredPath.endsWith('/v1') ? configuredPath : `${configuredPath}/v1`

function endpoint(path) {
  return new URL(`${apiPath}${path}`, baseUrl).toString()
}

async function request(path, init = {}) {
  return fetch(endpoint(path), {
    ...init,
    signal: AbortSignal.timeout(90_000),
  })
}

function headers(extra = {}) {
  return {
    authorization: `Bearer ${apiKey}`,
    ...extra,
  }
}

const unauthenticated = await request('/models')
assert.equal(unauthenticated.status, 401)

const queryCredential = await request(`/models?api_key=${encodeURIComponent(apiKey)}`)
assert.equal(queryCredential.status, 401)

const modelsResponse = await request('/models', { headers: headers() })
assert.equal(modelsResponse.status, 200)
const models = await modelsResponse.json()
assert.equal(models.object, 'list')
assert.ok(Array.isArray(models.data))
assert.ok(models.data.every((entry) => typeof entry?.id === 'string' && entry.object === 'model'))

for (const route of ['/completions', '/responses']) {
  const response = await request(route, {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ model: model ?? 'unsupported', prompt: 'contract-only' }),
  })
  assert.equal(response.status, 404)
}

const unsupported = await request('/chat/completions', {
  method: 'POST',
  headers: headers({ 'content-type': 'application/json' }),
  body: JSON.stringify({
    model: model ?? 'unsupported',
    messages: [{ role: 'user', content: 'contract-only' }],
    tools: [],
  }),
})
assert.equal(unsupported.status, 400)
const unsupportedBody = await unsupported.json()
assert.equal(unsupportedBody?.error?.code, 'unsupported_feature')

if (model) {
  assert.ok(models.data.some((entry) => entry.id === model), 'Configured model is unavailable')

  const completion = await request('/chat/completions', {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly COMPAT_OK.' }],
      stream: false,
    }),
  })
  assert.equal(completion.status, 200)
  const completionBody = await completion.json()
  assert.match(completionBody?.id ?? '', /^chatcmpl-/)
  assert.equal(completionBody?.object, 'chat.completion')
  assert.equal(typeof completionBody?.choices?.[0]?.message?.content, 'string')

  const stream = await request('/chat/completions', {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply with exactly STREAM_COMPAT_OK.' }],
      stream: true,
    }),
  })
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get('content-type') ?? '', /^text\/event-stream/i)
  const streamBody = await stream.text()
  assert.match(streamBody, /data: \{.+\}/)
  assert.ok(streamBody.includes('data: [DONE]'))
}

process.stdout.write(
  `Compatibility smoke passed: auth, models, unsupported fields, legacy routes${model ? ', JSON and SSE' : ''}.\n`,
)
