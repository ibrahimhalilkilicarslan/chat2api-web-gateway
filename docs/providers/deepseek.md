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

DeepSeek can report throttling inside an HTTP `200` SSE response. Non-stream
requests become HTTP `429`; streams receive a sanitized
`provider_rate_limited` SSE error. Empty output is treated as an error.

## Operational warning

The web protocol is undocumented and may break or trigger account controls.
Use a dedicated account, review applicable terms, and do not use account pools
to circumvent limits.
