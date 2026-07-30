# Public Release Checklist

The repository is not considered publicly released merely because it is
reachable or pushed to a remote. Complete this checklist before announcing a
version.

## Code and provenance

- [ ] Confirm GPL-3.0 compatibility and preserve upstream attribution.
- [ ] Confirm the repository history contains no credentials, cookies, tokens,
      provider payloads, SQLite files, or user data.
- [ ] Run secret scanning against the full Git history.
- [ ] Run `pnpm licenses:check` and review every dependency license.
- [ ] Tag an immutable reviewed commit.

## Product boundaries

- [ ] State prominently that DeepSeek web-session integration is unofficial.
- [ ] Verify unsupported OpenAI fields fail explicitly.
- [ ] Verify no official API fallback or arbitrary upstream URL exists.
- [ ] Verify prompts and completions are absent from logs and audit records.
- [ ] Document account-control and provider-terms risk.

## Installation

- [ ] Test `scripts/install.sh` on a clean supported Linux host.
- [ ] Test `pnpm setup` and `pnpm doctor` from a clean clone.
- [ ] Test HTTPS reverse-proxy deployment.
- [ ] Test loopback-only local deployment.
- [ ] Verify `.env` is mode `0600` and excluded from Git.
- [ ] Verify update and rollback documentation with a real backup.

## Quality

- [ ] Run `pnpm check`.
- [ ] Run Compose validation with disposable secrets.
- [ ] Build the production image without cache.
- [ ] Run `pnpm smoke:container`.
- [ ] Run an explicit provider JSON and SSE smoke with a dedicated test account.
- [ ] Review desktop and mobile admin screenshots with fixture-only data.
- [ ] Verify keyboard navigation, reduced motion, contrast, and form errors.

## Operations

- [ ] Configure automated SQLite backups outside the container volume.
- [ ] Test restore into an isolated volume.
- [ ] Configure readiness monitoring.
- [ ] Configure a provider-health alert without logging credentials.
- [ ] Publish a supported-version and security-reporting policy.
- [ ] Keep the admin console behind an identity-aware proxy where possible.
- [ ] Configure exact `CHAT2API_ADMIN_HOSTS` and verify the public API hostname
      returns `404` for `/admin/`.
- [ ] Configure an off-host backup destination and test one immutable copy.
- [ ] Configure the private security-reporting channel documented in
      `SECURITY.md`.
