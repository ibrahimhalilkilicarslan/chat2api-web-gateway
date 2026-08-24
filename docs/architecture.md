# Architecture

## Request path

1. Fastify applies body, authentication, key scope, scope-isolated RPM, chat quota, and concurrency limits.
2. A strict schema accepts text plus bounded inline PNG/JPEG/WebP/PDF content.
   Caller-supplied URLs and local paths are rejected before routing.
   Direct media uses the provider-compatible default model. Pro consumers run a
   separate media extraction request and forward only bounded untrusted evidence.
3. `ProviderRoutingEngine` selects an active DeepSeek web account and acquires a
   bounded, priority-aware account permit.
4. `DeepSeekAdapter` exchanges the stored user token, exclusively leases an
   upstream conversation, validates media signatures, uploads accepted files
   with a dedicated proof-of-work challenge, waits for extraction, and starts
   one request with the resulting `ref_file_ids`.
5. `DeepSeekStreamHandler` emits gateway-owned OpenAI-style IDs and sanitized
   text/citation output.
6. Successful leases return to the short-lived idle pool. Expired, invalid,
   timed-out, or abandoned leases are retired with best-effort deletion.

The in-memory lease pool stores only opaque upstream conversation IDs and never
prompt or response bodies. Clients preserve context by resending prior text
messages. Databases created by pre-hardening versions may retain an inert
`sessions` table, but the runtime never reads or writes it and new databases do
not create it.

## Runtime components

- Fastify API and admin server
- DeepSeek web adapter with fixed code-owned endpoints
- React/Vite admin assets under `/admin/`
- SQLite for encrypted account credentials, hashed API keys, settings,
  metadata-only request/audit records, and timestamp-only account usage events
- In-memory session lease, priority queue, concurrency, rate, health, and circuit state
- A persistent rolling account-usage window restores capacity gradually instead
  of locking an account until the next UTC day
- Configurable idle-account and rolling-usage reserves prevent background jobs
  from exhausting foreground capacity

Run one application replica per SQLite volume. Horizontal scaling requires a
coordinated database, quota, and circuit implementation.

## Trust boundaries

- Client requests, analytics exports, and DeepSeek responses are untrusted.
- Client credentials are accepted only in `Authorization: Bearer`.
- Admin mutations require a signed session, exact allowed origin, and CSRF token.
- Provider endpoints cannot be supplied by users or database records.
- Remote media, local paths, unsupported file types, and tool calls are rejected.
- Accepted inline media remains in memory and never crosses the persistence or
  log boundary; DeepSeek receives it only after an account has been selected.
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
