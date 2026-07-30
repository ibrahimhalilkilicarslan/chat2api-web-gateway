# DeepSeek web adapter

## Contract

- Provider ID: `deepseek`
- Fixed base: `https://chat.deepseek.com/api`
- Credential: DeepSeek browser user token
- Input: text-only `system`, `user`, and `assistant` messages
- Optional controls: `web_search`, `reasoning_effort`
- Output: non-stream JSON or OpenAI-style SSE

Images, files, tools, JSON mode, arbitrary sampling parameters, official API
keys, and legacy completion/Responses routes are unsupported and rejected.

## Isolation

Every gateway request creates a fresh DeepSeek conversation. The conversation is
not reused for another client or request and is deleted after the output ends,
fails, times out, or is abandoned. Context is supplied only by the caller's
current `messages` array.

Gateway response IDs are random `chatcmpl_...` values. DeepSeek session IDs,
message IDs, raw payloads, tokens, and cookies are not exposed or persisted.

## Health and rate limits

The admin health check calls only the fixed current-user endpoint and creates no
prompt. Scheduled checks can be disabled with
`CHAT2API_ACCOUNT_HEALTH_INTERVAL_MS=0`. Invalid credentials move an account to
error state; temporary throttling does not permanently disable it.

Credential health and traffic readiness are separate signals. A valid
current-user response proves only that the web session is accepted. The admin
overview claims operational readiness only after a real gateway request
succeeds, and it keeps recent throttling, timeout, protocol, and circuit-breaker
states visible until recovery is proven.

DeepSeek can report throttling inside an HTTP `200` SSE response. Non-stream
requests become HTTP `429`; streams receive a sanitized
`provider_rate_limited` SSE error. Empty output is treated as an error.

## Account onboarding

The admin console opens `chat.deepseek.com` in a separate browser tab. It does
not embed the login page, read cross-origin cookies, capture passwords, or
upload browser cookie/HAR files. An authorized operator explicitly pastes the
dedicated account's web session token. The server validates it before
persistence, strips an optional `Bearer` prefix, and stores it only after a
successful check using AES-256-GCM.

DeepSeek does not document this web-session workflow as an official public API.
Do not represent this onboarding as official OAuth or as equivalent to a
DeepSeek API key.

## Operational warning

The web protocol is undocumented and may break or trigger account controls.
Use a dedicated account, review applicable terms, and do not use account pools
to circumvent limits.
