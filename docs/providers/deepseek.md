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

The recommended flow uses the standalone, cross-platform **Chat2API Session
Connector**:

1. The authenticated admin creates a ten-minute, in-memory link session.
2. On Windows and Linux, the admin console invokes the installed connector
   through its per-user custom URL handler. The one-time capability is loaded
   directly into the local confirmation page.
3. The operator confirms the exact gateway hostname. Manual capability entry
   remains the recovery path and is the current macOS flow.
4. The connector launches an installed Chrome, Edge, Chromium, or Brave browser
   with a new temporary profile. The operator signs in on DeepSeek's own page.
5. After login, the connector reads only DeepSeek's `userToken` value, verifies
   it against DeepSeek's current-user endpoint inside the temporary browser,
   and posts it to the exact, one-time native gateway endpoint.
6. The temporary browser profile is destroyed when the operation ends.
7. The server validates the capability and provider session with the same web
   protocol headers used by normal gateway traffic before creating the account.
   Invalid sessions are not persisted, and authentication, throttling,
   availability, and protocol-change failures remain distinguishable.

The connector never attaches to the default browser profile. It does not read
the account password, OTP value, cookie archive, browsing history, or unrelated
local storage. It does not persist the provider token, upload HAR files, or
expose the token to the admin page. Native and legacy browser-extension
capabilities use independent secrets, are single-use, and expire after ten
minutes.

Manual token entry remains available as a recovery path. The server strips an
optional `Bearer` prefix, validates the token before persistence, and stores it
using AES-256-GCM.

DeepSeek does not document this web-session workflow as an official public API.
Do not represent this onboarding as official OAuth or as equivalent to a
DeepSeek API key.

### Connector installation

The admin console detects the current desktop operating system and links
directly to the immutable, tested connector archive. It does not send the
operator through the GitHub release listing. Architecture-specific alternatives
and the SHA-256 checksum manifest remain available under **Other operating
systems**:

- Windows: portable `.exe` archive
- macOS: `.app` archive for Intel or Apple Silicon
- Linux: portable archive for amd64 or arm64

Open the connector once after installation so Windows or Linux can register the
per-user launch handler. The account drawer can then open it directly. If the
handler is unavailable, copy the manual code, open the connector, verify the
gateway hostname, and continue. macOS currently uses this manual flow. Unsigned
development packages can trigger OS warnings. Public releases require
Authenticode signing and Apple Developer ID signing/notarization.

The previous unpacked browser extension remains a controlled recovery option
during the native connector transition. Its capability secret cannot be used
against the native endpoint.

## Operational warning

The web protocol is undocumented and may break or trigger account controls.
Use a dedicated account, review applicable terms, and do not use account pools
to circumvent limits.
