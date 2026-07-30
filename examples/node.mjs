const baseUrl = process.env.OPENAI_BASE_URL
const apiKey = process.env.OPENAI_API_KEY

if (!baseUrl || !apiKey) {
  throw new Error('Set OPENAI_BASE_URL and OPENAI_API_KEY')
}

const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Reply with exactly HELLO.' }],
    stream: false,
  }),
  signal: AbortSignal.timeout(90_000),
})

if (!response.ok) {
  throw new Error(`Gateway returned HTTP ${response.status}`)
}

const completion = await response.json()
process.stdout.write(`${completion.choices[0].message.content}\n`)
