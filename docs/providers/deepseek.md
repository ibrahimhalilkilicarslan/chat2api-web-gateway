# DeepSeek web adapter

## Contract

- Provider ID: `deepseek`
- Fixed base: `https://chat.deepseek.com/api`
- Credential: DeepSeek browser user token
- Input: text `system`/`assistant` messages and text or bounded inline-media
  `user` messages
- Optional controls: `web_search`, `reasoning_effort`
- Output: non-stream JSON or OpenAI-style SSE

PNG, JPEG, WebP, and PDF attachments are accepted only as inline base64 `data:`
URLs. The adapter validates decoded size and magic bytes, obtains a dedicated
upload PoW challenge, posts to the fixed DeepSeek file endpoint, waits for the
file to become ready, and forwards its ID in `ref_file_ids`. It never fetches a
remote URL or reads a caller-supplied local path.

The web file endpoint accepts the default model pipeline but rejects direct
`expert`/`deepseek-v4-pro` file references. Clients that require a Pro final
answer must first extract the attachment with `deepseek-v4-flash`, treat that
output as untrusted evidence, and send only the bounded extraction result to a
separate Pro request. Media requests use a fresh, non-reusable upstream session
so stale file references cannot leak between sequential requests.

Tools, arbitrary file types, JSON mode, arbitrary sampling parameters, official
API keys, and legacy completion/Responses routes are unsupported and rejected.

The file endpoint is an undocumented DeepSeek web protocol. Extracted/OCR data
is untrusted and is not payment verification. No verified upstream file-delete
operation is currently used, so DeepSeek account retention rules apply.

## Session lifecycle and isolation

The gateway leases an upstream DeepSeek conversation for one request at a time.
After a successful response, an idle lease can be reused for up to
`CHAT2API_DEEPSEEK_SESSION_TTL_MS` (five minutes by default). The same upstream
conversation is never used by concurrent requests. Every completion is sent
with a null parent and context is supplied by the caller's current `messages`
array. Expired or invalid leases are retired with best-effort upstream cleanup.

Set `CHAT2API_DEEPSEEK_SESSION_TTL_MS=0` when strict fresh-conversation isolation
is more important than minimizing upstream session churn. Because the DeepSeek
web protocol is undocumented, a controlled isolation smoke test is required
before enabling lease reuse in a multi-client deployment.

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

The current-user response can also report `chat.is_muted` with a provider
supplied `mute_until` timestamp. The gateway records this as
`provider_account_suspended`, removes the account from active routing, exposes
only the sanitized status and retry time to the admin console, and allows a
provider-timed health check to restore the account after the provider clears the
hold. The regular scheduled monitor remains a fallback.
The raw provider payload is never returned or logged.

## Queue priority

DeepSeek web accounts default to one concurrent request. Excess work waits in a
bounded queue instead of immediately failing with `no_available_account`.
Authenticated clients can mark non-interactive work with
`X-Chat2API-Priority: background`; omitted or `foreground` requests are served
before queued background work. Priority never interrupts an in-flight request.

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

Automated or high-frequency access from VPS and datacenter egress addresses can
be classified differently from normal browser use and may result in temporary
or permanent provider restrictions. This gateway does not implement rotating
proxies, residential egress, browser-fingerprint spoofing, randomized
"human-like" timing, or other anti-detection behavior. Operators must use only
accounts they control and workflows the provider permits. A valid session is
not evidence that generation is permitted; treat a successful controlled text
request as the operational readiness signal.
