# Security

## Implemented controls

- Strong startup secrets and exact admin-origin allowlist
- AES-256-GCM credential vault; every envelope is verified at startup
- Hash-only client API keys with scopes, model allowlists, expiry, exact
  IP/CIDR restrictions, RPM limits, daily quotas, and grace-period rotation
- Signed expiring admin sessions, SameSite Strict cookies, and CSRF mutations
- Strict text/media schema, bounded request bodies, decoded-size limits, and
  PNG/JPEG/WebP/PDF magic-byte validation
- Request, first-byte, and stream-idle timeouts with client-abort propagation
- Exclusive upstream session leases with configurable zero-TTL isolation and
  best-effort retirement
- Gateway-owned opaque response IDs
- Bounded priority queues, account concurrency limits, failover, cooldowns, and
  credential health checks
- Scope-isolated RPM windows plus foreground concurrency and persistent rolling-usage
  reserves keep health checks and background analysis from exhausting interactive chat capacity
- Metadata-only request and audit logs
- Fixed provider endpoints; no custom provider, remote-media fetch, local-path,
  arbitrary-file, or tool surface
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

The account field historically named `dailyLimit` is retained in the admin API
for compatibility, but routing interprets it as the maximum number of provider
attempts in `CHAT2API_ACCOUNT_USAGE_WINDOW_MS`. API-key `dailyQuota` remains a
separate hard daily client-security limit.

This gateway does not make web-session automation equivalent to an official API.

DeepSeek's web file-upload protocol is undocumented. Inline files are decoded
in memory and are never written to gateway logs or storage, but accepted files
are uploaded to the configured DeepSeek account for extraction. The upstream
protocol currently exposes no verified deletion operation, so callers must
assume DeepSeek's own retention policy applies. OCR or document extraction is
untrusted evidence and must not be treated as bank/payment verification.
