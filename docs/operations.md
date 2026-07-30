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

DeepSeek may report throttling as an SSE error inside an HTTP `200` provider
response. The gateway converts that condition to HTTP `429` for non-stream
requests and emits a `provider_rate_limited` SSE error event for streaming
requests. An empty successful completion must not be treated as provider health.
Unsupported fields such as `tools`, `response_format`, media parts, or sampling
controls must return `400 unsupported_feature`; legacy completion routes return
`404`.

Request, first-byte, stream-idle, and account-health timeouts are deployment
environment settings. The admin UI reports them but does not create a second
runtime configuration source.

## Backup

Use the hosting platform's consistent volume snapshot while the container is
stopped, or use the SQLite online backup command:

```bash
CHAT2API_DATABASE_PATH=/data/chat2api.sqlite \
CHAT2API_BACKUP_PATH=/secure/off-volume/chat2api-$(date -u +%Y%m%dT%H%M%SZ).sqlite \
pnpm backup:sqlite
```

The command refuses destinations inside the source repository, refuses
overwrites, sets mode `0600`, and verifies `PRAGMA integrity_check`. Copying only
the main SQLite file while WAL writes are active is not a valid backup. A backup
inside the same persistent volume is not disaster recovery; export it to
restricted off-volume storage.

The runtime image includes the root-owned script at
`/app/scripts/backup-sqlite.mjs`; invoke it with `node` when running from a
container console where pnpm is unavailable.

Verify any copied or archived backup again without opening it for writes:

```bash
CHAT2API_BACKUP_PATH=/secure/off-volume/chat2api-YYYYMMDD.sqlite \
pnpm backup:verify
```

Run an isolated restore drill against an already built immutable image:

```bash
CHAT2API_BACKUP_PATH=/secure/off-volume/chat2api-YYYYMMDD.sqlite \
CHAT2API_MASTER_KEY="<separately-protected-key>" \
CHAT2API_RESTORE_IMAGE=chat2api-web-gateway:<commit> \
pnpm restore:drill
```

The drill creates a disposable Docker volume, restores the database, validates
credential decryption, readiness, the authentication boundary and the models
contract, then removes the container and volume. It does not generate provider
content and never modifies the source backup.

Back up the master encryption key separately from the database. Test restoration
periodically in an isolated environment.

### Automated host operations

The repository includes least-privilege host runners that use the existing
Docker access of the operations user. They never restart the application, read
container environment values, or invoke Coolify:

- `scripts/ops/run-production-backup.sh` creates an online SQLite backup inside
  the running container, verifies it, copies it off the Docker volume, compares
  SHA-256 checksums, removes the temporary volume copy, and prunes only matching
  backups older than the configured retention.
- `scripts/ops/check-production-health.sh` verifies container hardening,
  liveness, readiness, fail-closed API authentication, the authenticated models
  contract, and backup freshness. It never generates provider content.
- `scripts/ops/install-host-operations.sh` installs working copies under the
  current user's `~/.local/libexec` and replaces only its own marked crontab
  block.
- `scripts/ops/notify-operations.sh` sends only coarse service/event/status/time
  data to an optional HTTPS webhook.

Install or refresh the jobs from a trusted checkout:

```bash
CHAT2API_COMPOSE_PROJECT=<coolify-compose-project> \
CHAT2API_REMOTE_ENV="$HOME/.config/chat2api-web-gateway/remote-client.env" \
scripts/ops/install-host-operations.sh
```

The installed schedule runs backup daily at `02:43` and health monitoring every
five minutes. Defaults:

- Backups: `~/.local/share/chat2api-web-gateway/backups`
- State and logs: `~/.local/state/chat2api-web-gateway`
- Retention: 30 days
- Maximum accepted backup age: 26 hours

Run both checks immediately after installation:

```bash
CHAT2API_COMPOSE_PROJECT=<coolify-compose-project> \
~/.local/libexec/chat2api-web-gateway/run-production-backup.sh

CHAT2API_COMPOSE_PROJECT=<coolify-compose-project> \
~/.local/libexec/chat2api-web-gateway/check-production-health.sh
```

The monitor records only a timestamp and coarse status. State transitions to
failed/recovered are sent to the local system logger without credentials or
provider content. The local host backup protects against application-container
or Docker-volume loss, but not total host loss. Replicate verified backup files
and the separately protected master key to access-controlled off-host storage.

Optional operations settings live outside the repository:

```bash
install -d -m 0700 "$HOME/.config/chat2api-web-gateway"
install -m 0600 scripts/ops/operations.env.example \
  "$HOME/.config/chat2api-web-gateway/operations.env"
```

Set `CHAT2API_OFFSITE_RCLONE_REMOTE` to copy each verified immutable backup to
an access-controlled rclone destination. Keep rclone credentials in its private
configuration. Set `CHAT2API_ALERT_WEBHOOK_URL` to receive coarse backup,
health, and release events. The webhook never receives prompts, responses,
tokens, provider details, account IDs, or error payloads.

## Remote smoke

Read credentials from environment variables or a mode-`0600` environment file;
never place API keys in command arguments:

```bash
set -a
. /secure/path/remote-client.env
set +a
CHAT2API_SMOKE_MODEL=deepseek-v4-flash \
CHAT2API_SMOKE_STREAM=true \
pnpm smoke:remote
```

Without `CHAT2API_SMOKE_MODEL`, the command checks readiness, the unauthenticated
boundary, and the authenticated models contract without consuming provider
generation. With a model, it also checks non-stream and optionally stream output.

Schedule readiness/model checks externally. Alert on readiness failures,
repeated `provider_rate_limited` activity, authentication errors, open circuits,
and backup age. Do not send prompts, responses, or credentials to alerting tools.

## Rotation

- Environment bootstrap API key: replace the environment secret and restart.
  The previous bootstrap key is revoked atomically; admin-created keys remain.
- Client API keys can be rotated in the admin console with a bounded grace
  period; the replacement inherits scopes, allowlist, quotas, and IP policy.
- Admin token: replace secret and restart; existing signed sessions remain valid
  until session-secret rotation or expiry.
- Session secret: replace and restart to invalidate all admin sessions.
- Provider token: update through the admin console.
- Master key: no online rotation exists. Do not change it casually.

Startup validates every encrypted credential with the configured master key. A
wrong key keeps readiness down instead of silently serving a broken gateway.

## Incident response

1. Disable the affected API key or DeepSeek account.
2. Preserve metadata and infrastructure logs without copying prompt content.
3. Rotate exposed provider/API/admin/session credentials.
4. Inspect request and audit metadata for time, model, provider, account, and result.
5. Patch and verify with `pnpm check`.
6. Deploy an immutable image and run the smoke checklist.

Never include tokens, cookies, prompts, or full provider responses in incident tickets.
