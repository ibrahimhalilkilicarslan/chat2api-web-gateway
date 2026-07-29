# Security

## Implemented controls

- Mandatory strong startup secrets and exact admin origins
- AES-256-GCM provider credential vault with authenticated envelopes
- Startup validation of every credential envelope; a wrong master key fails closed
- Hash-only client API key storage
- Signed, expiring admin sessions and SameSite Strict cookies
- CSRF protection for all admin mutations
- Bearer-only API authentication, RPM limits, daily quotas, model allowlists
- Strict request schemas and a 2 MiB default body limit
- Global and account-level concurrency controls
- Circuit breakers and bounded pre-first-byte failover
- Metadata-only request/audit logs
- Helmet CSP, HSTS in production, no-referrer, and frame denial
- Custom provider prohibition and complete remote-media URL rejection
- Non-root, read-only, capability-free container
- Immutable Dockerfile frontend and Node base-image digests
- Commit-pinned GitHub Actions and scheduled dependency update proposals
- Production removal of legacy adapter console diagnostics

## Required operating controls

- Put `/admin/` behind Tailscale, Cloudflare Access, or an equivalent identity-aware proxy.
- Use dedicated provider accounts with the minimum value and permissions possible.
- Keep the SQLite volume encrypted and backed up by the infrastructure layer.
- Never send provider credentials through chat, tickets, screenshots, or logs.
- Rotate API/admin/session secrets after suspected exposure.
- Keep the master encryption key stable and separately backed up.
- Review provider terms and obtain authorization before business-critical use.

## Known residual risks

Provider web endpoints are undocumented and can change without notice. Session
tokens can grant broad provider-account access. Local in-memory RPM and circuit
state reset after restart. SQLite is suitable for a single replica only.

No gateway can make unofficial provider automation equivalent to an official API.
