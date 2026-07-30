# Architecture

## Request path

1. Fastify applies body, authentication, key scope, RPM, quota, and concurrency limits.
2. A strict schema accepts only the documented text-chat contract.
3. `ProviderRoutingEngine` selects an active DeepSeek web account.
4. `DeepSeekAdapter` exchanges the stored user token, creates a fresh upstream
   conversation, completes the proof-of-work challenge, and starts one request.
5. `DeepSeekStreamHandler` emits gateway-owned OpenAI-style IDs and sanitized
   text/citation output.
6. The upstream conversation is deleted after success, error, timeout, abort, or
   downstream disconnect.

There is no cross-request conversation cache. Clients preserve context by
resending prior text messages. Databases created by pre-hardening versions may
retain an inert `sessions` table, but the runtime never reads or writes it and
new databases do not create it.

## Runtime components

- Fastify API and admin server
- DeepSeek web adapter with fixed code-owned endpoints
- React/Vite admin assets under `/admin/`
- SQLite for encrypted account credentials, hashed API keys, settings, and
  metadata-only request/audit records
- In-memory concurrency, rate, health, and circuit state

Run one application replica per SQLite volume. Horizontal scaling requires a
coordinated database, quota, and circuit implementation.

## Trust boundaries

- Client requests, analytics exports, and DeepSeek responses are untrusted.
- Client credentials are accepted only in `Authorization: Bearer`.
- Admin mutations require a signed session, exact allowed origin, and CSRF token.
- Provider endpoints cannot be supplied by users or database records.
- Media and tool calls are rejected before routing.
- Prompt and completion bodies never cross the persistence or log boundary.

## Failure semantics

- Invalid client input: `400`
- Missing/invalid gateway key: `401` or `403`
- No usable DeepSeek account: `503`
- DeepSeek throttling: `429` with bounded retry guidance
- DeepSeek timeout: `504`
- Protocol/upstream failure: sanitized `502`

Streaming responses are primed before the HTTP success is committed. After the
first byte, errors are emitted as SSE error objects and the stream terminates.
