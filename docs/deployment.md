# Coolify Deployment

## Preflight

1. Run `pnpm check`.
2. Validate `docker compose -f compose.yaml -f compose.local.yaml config` with
   disposable values.
3. Build an immutable image and run `pnpm smoke:container`.
4. Confirm only `/data` is writable and persistent.
5. Confirm no source, `.env`, backup directory, or Docker socket is mounted.

## Required secrets

- `CHAT2API_MASTER_KEY`: base64-encoded 32 random bytes
- `CHAT2API_BOOTSTRAP_API_KEY`: at least 32 random characters
- `CHAT2API_ADMIN_TOKEN`: at least 32 random characters
- `CHAT2API_SESSION_SECRET`: at least 32 random characters
- `CHAT2API_ADMIN_ORIGINS`: comma-separated exact HTTPS origins
- `CHAT2API_ADMIN_HOSTS`: comma-separated exact admin request hostnames
- `CHAT2API_TRUST_PROXY`: bounded proxy hop count, normally `1`

Operational limits include:

- `CHAT2API_REQUEST_TIMEOUT_MS`
- `CHAT2API_FIRST_BYTE_TIMEOUT_MS`
- `CHAT2API_STREAM_IDLE_TIMEOUT_MS`
- `CHAT2API_ACCOUNT_HEALTH_INTERVAL_MS` (`0` disables scheduled checks)
- `CHAT2API_ACCOUNT_CONCURRENCY` (DeepSeek web accounts default to one active request)
- `CHAT2API_ACCOUNT_USAGE_WINDOW_MS` (default `900000`; account limits recover gradually)
- `CHAT2API_BACKGROUND_USAGE_RESERVE` (usage slots kept for foreground requests)
- `CHAT2API_QUEUE_MAX_DEPTH` and `CHAT2API_QUEUE_TIMEOUT_MS`
- `CHAT2API_DEEPSEEK_SESSION_TTL_MS` (`0` disables session reuse)
- global concurrency, RPM, and daily quota variables

Store all real values only in Coolify secret configuration. Unrestricted
`CHAT2API_TRUST_PROXY=true` is rejected.

## Coolify configuration

- Build from `Dockerfile` or `compose.yaml`.
- Route HTTPS to container port `8080`; do not publish an extra host port.
- Mount one persistent volume at `/data`.
- Keep one running replica.
- Use `/health/ready` for readiness.
- Restrict `/admin/` at the network or identity-aware proxy layer and configure
  a dedicated exact admin hostname where possible.
- Never mount the Docker socket.

After deployment, create/update the DeepSeek web account through the HTTPS admin
console, run its credential-only health check, then perform one explicit
non-stream and stream smoke with non-sensitive prompts.

## Rollback

1. Preserve the previous immutable image.
2. Create and verify an online SQLite backup before change.
3. Deploy without changing `CHAT2API_MASTER_KEY`.
4. If health or smoke fails, restore the prior image first.
5. Restore data only when a schema/data fault is proven.

Never replace the persistent volume with an empty directory during rollback.

The release helper records the previous image ID but intentionally never
restores data automatically:

```bash
COOLIFY_URL=https://coolify.example.com \
COOLIFY_TOKEN="<private-token>" \
COOLIFY_RESOURCE_UUID="<resource-uuid>" \
CHAT2API_COMPOSE_PROJECT="<compose-project>" \
scripts/ops/release-coolify.sh
```

When the release runs on the Coolify host itself, `COOLIFY_URL` may use the
loopback API origin, for example `http://127.0.0.1:8000`. Plain HTTP is rejected
for every non-loopback host.

It requires a clean commit equal to `origin/main`, runs the complete quality
gate, immutable local image smoke, verified backup, Coolify deployment, new
container health, and remote smoke. A host-side file lock rejects overlapping
release attempts. If deployment fails, select the recorded previous
deployment/image in Coolify. Restore SQLite only after a proven data fault and
an isolated restore drill.
