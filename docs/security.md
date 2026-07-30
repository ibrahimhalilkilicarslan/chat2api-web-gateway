# Security

## Implemented controls

- Strong startup secrets and exact admin-origin allowlist
- AES-256-GCM credential vault; every envelope is verified at startup
- Hash-only client API keys with scopes, model allowlists, expiry, exact
  IP/CIDR restrictions, RPM limits, daily quotas, and grace-period rotation
- Signed expiring admin sessions, SameSite Strict cookies, and CSRF mutations
- Strict text-only request schema and bounded request bodies
- Request, first-byte, and stream-idle timeouts with client-abort propagation
- Fresh upstream conversation per request and best-effort deletion on every exit
- Gateway-owned opaque response IDs
- Account concurrency limits, failover, cooldowns, and credential health checks
- Metadata-only request and audit logs
- Fixed provider endpoints; no custom provider, media, file, or tool surface
- Helmet CSP, production HSTS, no-referrer, and frame denial
- Non-root, read-only, capability-free container
- Exact admin-host and browser-origin restrictions
- Commit-pinned CI actions, full-history secret scanning, production dependency
  vulnerability checks, and an allowlisted production-license audit

## Operating controls

- Restrict `/admin/` with Tailscale or an identity-aware proxy.
- Use a separate admin hostname and enforce it with
  `CHAT2API_ADMIN_HOSTS`; see [Admin Access](admin-access.md).
- Use a dedicated DeepSeek account; do not reuse a personal high-value account.
- Install the native Session Connector only from an immutable, checksum-verified
  project release. Review the exact gateway hostname before every link.
- The connector starts a non-default temporary browser profile and reads only
  DeepSeek's `userToken` after explicit login. It does not inspect the default
  profile, password, OTP, cookies, history, or unrelated storage.
- Native and browser-extension capabilities use separate high-entropy secrets.
  The native endpoint requires a non-browser header, rejects browser origins,
  exposes no CORS policy, and validates the provider session before encrypted
  persistence.
- Do not use multiple accounts to evade provider quotas or controls.
- Keep the SQLite volume encrypted and export verified backups off-host.
- Store the master key separately from database backups.
- Never paste tokens into source, chat, screenshots, tickets, or command history.
- Review DeepSeek terms and obtain approval appropriate to the workload.
- Rotate client/admin/session/provider credentials after suspected exposure.

## Residual risks

DeepSeek web endpoints and anti-automation challenges are undocumented and can
change without notice. A web token may grant broad account access. Health checks
prove only that the token currently works, not future compatibility. In-memory
rate/circuit state resets on restart, IP allowlists depend on correct bounded
reverse-proxy trust, and SQLite supports one active replica.

This gateway does not make web-session automation equivalent to an official API.
