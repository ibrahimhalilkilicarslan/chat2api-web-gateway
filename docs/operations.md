# Operations Runbook

## Smoke checks

Run `CHAT2API_SMOKE_IMAGE=<immutable-image-tag> pnpm smoke:container` before
release. This checks the security envelope without provider credentials. Then
perform the following operational checks:

1. `/health/live` returns `200`.
2. `/health/ready` returns `200`.
3. `/v1/models` without Bearer auth returns `401`.
4. `/v1/models?api_key=...` returns `401`.
5. Admin login rejects an unlisted origin.
6. Admin login, CSRF mutation, and logout succeed from the configured origin.
7. Account list never returns credential fields.
8. A generated client key appears once and is absent from later list responses.
9. A dedicated provider test account completes non-stream and stream requests.
10. Request activity contains metadata only, never prompts or responses.

## Backup

Use the hosting platform's consistent volume snapshot while the container is
stopped, or use a SQLite-aware online backup process. Copying only the main SQLite
file while WAL writes are active is not a valid backup.

Back up the master encryption key separately from the database. Test restoration
periodically in an isolated environment.

## Rotation

- Environment bootstrap API key: replace the environment secret and restart.
  The previous bootstrap key is revoked atomically; admin-created keys remain.
- Client API keys: create replacement, migrate clients, disable/delete old key.
- Admin token: replace secret and restart; existing signed sessions remain valid
  until session-secret rotation or expiry.
- Session secret: replace and restart to invalidate all admin sessions.
- Provider token: update through the admin console.
- Master key: no online rotation exists. Do not change it casually.

Startup validates every encrypted credential with the configured master key. A
wrong key keeps readiness down instead of silently serving a broken gateway.

## Incident response

1. Disable the affected API key or provider account.
2. Preserve metadata and infrastructure logs without copying prompt content.
3. Rotate exposed provider/API/admin/session credentials.
4. Inspect request and audit metadata for time, model, provider, account, and result.
5. Patch and verify with `pnpm check`.
6. Deploy an immutable image and run the smoke checklist.

Never include tokens, cookies, prompts, or full provider responses in incident tickets.
