# Architecture

## Runtime

The application is a single Node.js process:

1. Fastify accepts admin and OpenAI-compatible requests.
2. Authentication, quota, schema, body-size, and concurrency guards run before routing.
3. `ProviderRoutingEngine` selects an enabled built-in provider and active account.
4. The legacy provider implementation is reachable only through
   `src/legacy/provider-runtime.js`.
5. Streaming responses are primed before HTTP 200 is committed, allowing safe
   failover only before the first byte.
6. SQLite stores configuration, encrypted credentials, hashed API keys, sessions,
   metadata-only request records, and audit events.
7. React/Vite assets are served from `/admin/`.

## Trust boundaries

- Client API keys are untrusted and never accepted in URLs.
- Admin browser requests require exact origin, signed session, and CSRF validation.
- Provider responses and errors are untrusted.
- Provider endpoints are fixed built-ins; arbitrary custom URLs are prohibited.
- Remote image URLs are prohibited. Supported image inputs use validated,
  bounded base64 data URLs only.
- No production prompt or completion body crosses the persistence boundary.

## Persistence

`/data/chat2api.sqlite` uses WAL, foreign keys, a busy timeout, and mode `0600`.
Provider credentials are encrypted independently before insertion. Request history
is bounded by the configured metadata log limit; audit records are bounded to 2,000
entries, and daily quota rows older than 90 days are pruned.

The gateway does not provide distributed locking. Run one replica per SQLite
volume. Horizontal scaling requires replacing local rate/concurrency state and
SQLite with coordinated services.
