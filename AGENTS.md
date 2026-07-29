# Chat2API Web Gateway

## Mission

Maintain a web-only, isolated OpenAI-compatible gateway. The project must not
depend on Electron, a desktop session, Xvfb, noVNC, Docker socket access, or
production credentials checked into source control.

## Security invariants

- Authentication is fail-closed. API and admin routes never become public
  because an environment variable is missing.
- Provider credentials are encrypted with AES-256-GCM before SQLite writes.
- API keys are stored as one-way hashes and shown only once at creation time.
- Prompts, responses, cookies, tokens, authorization headers, and credential
  payloads are never persisted in logs.
- Custom upstream URLs are disabled. Built-in provider endpoints are code-owned.
- Remote media fetching is disabled by default and private network destinations
  are always rejected.
- Admin cookies are HttpOnly, Secure in production, SameSite=Strict, and all
  mutations require CSRF and same-origin checks.
- Never weaken Docker isolation, run as root, mount the Docker socket, or add
  privileged capabilities.

## Commands

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit:prod
pnpm check
pnpm smoke:container
```

## Change policy

- Keep provider-specific protocol code behind the gateway boundary.
- Add tests for authentication, encryption, request validation, quota handling,
  failover, SSRF controls, and secret redaction.
- Do not claim a provider integration is healthy without a controlled account
  smoke test.
- Provider web-session automation may violate provider terms or trigger account
  controls; document this operational risk rather than hiding it.
