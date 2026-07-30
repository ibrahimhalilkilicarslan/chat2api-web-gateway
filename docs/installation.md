# Installation

## Recommended production shape

Use one gateway replica behind an HTTPS reverse proxy. Persist only `/data`, do
not publish an additional host port, and do not mount the Docker socket, source
tree, credentials, or backup directories into the container.

```text
HTTPS reverse proxy
  -> gateway:8080
  -> /data/chat2api.sqlite
```

The exact public origin must be listed in `CHAT2API_ADMIN_ORIGINS`, and its
hostname must be listed in `CHAT2API_ADMIN_HOSTS`. The admin session is
origin-bound, uses secure cookies in production, and rejects cross-site
mutations.

## One-command Docker setup

Requirements:

- Docker Engine
- Docker Compose v2
- OpenSSL
- an HTTPS hostname routed to container port `8080`

```bash
git clone https://github.com/ibrahimhalilkilicarslan/chat2api-web-gateway.git
cd chat2api-web-gateway
./scripts/install.sh --origin https://gateway.example.com
```

The installer fails safely when `.env` already exists. It never replaces active
secrets or prints the admin token.

Retrieve the token locally:

```bash
./scripts/show-admin-token.sh
```

Do not paste this value into issue reports, shell history shared with other
users, source files, screenshots, or chat conversations.

## Manual or developer setup

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm setup -- --origin https://gateway.example.com
pnpm doctor
docker compose up -d --build
```

For loopback development:

```bash
pnpm setup -- --origin http://localhost:8080
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

The setup command uses non-secure cookies only for an exact loopback origin.
Non-loopback HTTP origins are rejected.

## Existing environment

Do not regenerate `CHAT2API_MASTER_KEY` after provider credentials have been
stored. To inspect an existing setup:

```bash
pnpm doctor
docker compose ps
docker compose logs --tail=100 gateway
```

To intentionally replace a development `.env`:

```bash
pnpm setup -- --origin http://localhost:8080 --force
```

The previous file is copied to `.env.bak.<timestamp>` with mode `0600`. Remove
obsolete backups after validating the replacement.

## First-run onboarding

1. Open `/admin/`.
2. Sign in with the locally retrieved admin token.
3. Add a dedicated DeepSeek web account.
4. Run `Bağlantıyı test et`.
5. Create a separate API key for each client with the minimum scopes, model
   allowlist, expiry, quota, and stable egress IP/CIDR policy.
6. Store each raw client key immediately; it is shown once.
7. Send one non-sensitive JSON request.
8. Send one non-sensitive streaming request.
9. Confirm activity metadata contains no prompt or response content.

## Coolify

Use `compose.yaml` or the `Dockerfile`.

- route HTTPS to port `8080`,
- mount one persistent volume at `/data`,
- configure `/health/ready` as readiness,
- keep the container non-root and read-only,
- set every required environment value as a secret,
- keep `CHAT2API_TRUST_PROXY` bounded, normally `1`,
- set exact `CHAT2API_ADMIN_ORIGINS` and `CHAT2API_ADMIN_HOSTS`,
- never mount `/var/run/docker.sock`.

Coolify deployments should not run `scripts/install.sh`; configure secrets in
Coolify and let Compose consume them. See [Deployment](deployment.md).

## Updating

Before updating:

1. run `pnpm check`,
2. create and verify an online SQLite backup,
3. preserve the current image reference,
4. keep `CHAT2API_MASTER_KEY` unchanged,
5. deploy one replica,
6. verify readiness, admin login, models, JSON chat, and stream chat.

Rollback the image before restoring data unless a data fault is proven.

For client examples and key policy guidance, see
[Client Quickstart](client-quickstart.md). For a dedicated protected admin
hostname, see [Admin Access](admin-access.md).

## Uninstalling

Stopping containers does not delete data:

```bash
docker compose down
```

Deleting the named volume permanently removes accounts, client keys, metadata,
and settings. Never run `docker compose down -v` without a verified backup and
explicit intent.
