# DeepSeek

The gateway exposes two code-owned DeepSeek integrations with an explicit
priority order.

| Provider ID | Mode | Credential | Priority |
| --- | --- | --- | --- |
| `deepseek-api` | Official API | `apiKey` | 10 |
| `deepseek` | Web-session compatibility fallback | `token` | 100 |

Lower priority numbers are attempted first. If an active official API account is
available, standard requests use it. A retryable official API failure can fall
back to an active web-session account. Requests that explicitly require web
search skip providers that declare no web-search capability.

## Official API

- Base URL: `https://api.deepseek.com`
- Chat path: `/chat/completions`
- Health check: credential-only `GET /models`
- Models: `deepseek-v4-flash`, `deepseek-v4-pro`
- Native tool calls, JSON output, streaming usage, and thinking controls are
  forwarded in OpenAI-compatible format.

Create a dedicated official API key, add it under **DeepSeek Official API**, test
the connection, and only then enable the provider. The legacy
`deepseek-chat`/`deepseek-reasoner` names are intentionally not advertised.

## Web-session fallback

- Base URL: `https://chat.deepseek.com/api`
- Credential: browser user token
- Supports the current V4 models plus web-search/thinking compatibility
- Health check validates the session without creating a prompt

Web-session endpoints are undocumented and may break, trigger account controls,
or conflict with provider terms. Keep this integration as a compatibility
fallback rather than a production-critical dependency.

## Rate limiting

HTTP `Retry-After` from the official API is propagated into the account circuit
breaker and the gateway's final HTTP `429`. The web endpoint can encode
throttling inside an HTTP `200` SSE event; non-stream requests are converted to
HTTP `429`, while streaming requests receive a `provider_rate_limited` SSE error
event. Empty content is never accepted as a successful non-stream response.
