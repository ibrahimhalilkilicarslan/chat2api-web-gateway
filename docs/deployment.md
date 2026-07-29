# Coolify Deployment

## Preflight

1. Run `pnpm check`.
2. Run `docker compose -f compose.yaml -f compose.local.yaml config` with temporary
   non-production values.
3. Build the image locally.
4. Run `pnpm smoke:container` against the locally built image.
5. Confirm no host Docker socket, source directory, `.env`, or backup directory is mounted.
6. Confirm only `/data` is writable and persistent.

## Required secrets

- `CHAT2API_MASTER_KEY`: exactly 32 random bytes encoded as base64
- `CHAT2API_BOOTSTRAP_API_KEY`: at least 32 random characters
- `CHAT2API_ADMIN_TOKEN`: at least 32 random characters
- `CHAT2API_SESSION_SECRET`: at least 32 random characters
- `CHAT2API_ADMIN_ORIGINS`: comma-separated exact HTTPS origins
- `CHAT2API_TRUST_PROXY`: trusted reverse-proxy hop count; normally `1` for a
  single Coolify/Traefik hop and `false` for direct local access

Store these only in Coolify's secret environment configuration. Do not commit a
production `.env`.

Do not use `CHAT2API_TRUST_PROXY=true`; unrestricted forwarded-header trust is
rejected at startup. If another proxy or CDN is added, verify the real hop count
before changing this value.

## Coolify configuration

- Build from `Dockerfile` or `compose.yaml`.
- Update pinned base-image digests only through a reviewed dependency update.
- Route the application domain to container port `8080`.
- Mount a named/persistent volume at `/data`.
- Keep one running replica.
- Keep healthcheck path `/health/ready`.
- Enable HTTPS before using secure admin cookies.
- Restrict admin access with Tailscale or an identity-aware proxy.
- Do not publish an extra host port.

The automated smoke starts only an isolated loopback-bound container with
disposable secrets and a temporary in-memory `/data` mount. It does not configure
or call provider accounts.

## Rollback

1. Keep the previous immutable image/version.
2. Take an infrastructure-level consistent snapshot of `/data`.
3. Deploy the new image without changing `CHAT2API_MASTER_KEY`.
4. If health or smoke checks fail, restore the prior image.
5. Restore the data snapshot only if a schema/data problem is proven; image rollback
   alone is preferred.

There is currently one additive SQLite schema version. Never replace the volume
with an empty directory during an upgrade.
