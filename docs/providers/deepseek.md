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

The recommended flow uses the optional **Chat2API DeepSeek Session Connector**
browser extension:

1. The authenticated admin creates a five-minute, in-memory link session.
2. The admin console copies a one-time capability and opens
   `chat.deepseek.com`.
3. The operator confirms the exact gateway hostname in the extension and signs
   in on DeepSeek's own page.
4. After login, a main-world script reads only DeepSeek's `userToken` value and
   posts it from the fixed `https://chat.deepseek.com` origin to the exact,
   one-time gateway endpoint.
5. The server validates the capability and provider session before creating the
   account. Invalid sessions are not persisted.

The extension does not request browser cookie, history, download, or
`webRequest` permissions. It does not read the account password, persist the
provider token in extension storage, upload HAR files, or expose the token to
the admin page. The capability is single-use, bound to the admin-created
session, origin-checked, and expires after five minutes.

Manual token entry remains available as a recovery path. The server strips an
optional `Bearer` prefix, validates the token before persistence, and stores it
using AES-256-GCM.

DeepSeek does not document this web-session workflow as an official public API.
Do not represent this onboarding as official OAuth or as equivalent to a
DeepSeek API key.

### Connector installation

Download `deepseek-session-connector-v1.0.0.zip` from the account drawer in the
admin console. Extract it and load the folder as an unpacked extension from
`chrome://extensions` or `edge://extensions`. Pin the extension before starting
the first link.

The unpacked extension is intended for controlled operator browsers. A public
store release requires separate signing, review, privacy disclosure, and update
governance.

## Operational warning

The web protocol is undocumented and may break or trigger account controls.
Use a dedicated account, review applicable terms, and do not use account pools
to circumvent limits.
