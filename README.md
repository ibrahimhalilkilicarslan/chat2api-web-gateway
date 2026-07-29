# Chat2API Web Gateway

Security-hardened, web-only derivative of
[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API). It exposes a limited
OpenAI-compatible API and a responsive administration console without Electron,
Koa, Xvfb, noVNC, or a browser automation surface.

## Security model

- API access is fail-closed and accepts credentials only as `Authorization: Bearer`.
- Provider credentials are encrypted at rest with AES-256-GCM.
- API keys are stored as SHA-256 hashes and displayed only once at creation.
- Admin sessions use signed, HttpOnly cookies, exact-origin checks, and CSRF tokens.
- Prompt and response bodies are never persisted.
- Custom provider URLs are disabled; built-in endpoints are fixed in source.
- Remote media URLs are rejected; supported images must be bounded base64 data URLs.
- Global/per-account concurrency, per-key RPM, daily quotas, and circuit breakers are enforced.
- Production builds remove legacy provider console diagnostics.
- The container runs as UID/GID `10001`, with a read-only root filesystem and no Linux capabilities.

Provider adapters automate undocumented web-session endpoints. This can violate a
provider's terms, trigger account controls, or stop working without notice. Use
dedicated accounts, obtain provider approval where required, and prefer official
APIs for production-critical workloads.

## API surface

| Route | Purpose |
| --- | --- |
| `GET /health`, `/health/live`, `/health/ready` | Minimal health endpoints |
| `GET /v1/models` | Models available through active accounts |
| `POST /v1/chat/completions` | OpenAI-compatible chat, including SSE |
| `POST /v1/completions` | Non-streaming legacy completion adapter |
| `POST /v1/responses` | Non-streaming Responses API subset |
| `/admin/` | Web administration console |

## Local development

Requirements: Node.js `22.22.2+`, Corepack, and pnpm `11.17.0`.

```bash
corepack enable
corepack prepare pnpm@11.17.0 --activate
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Generate every secret independently:

```bash
openssl rand -base64 32  # CHAT2API_MASTER_KEY
openssl rand -base64 48  # API key, admin token, session secret
```

Never rotate `CHAT2API_MASTER_KEY` without decrypting and re-encrypting existing
provider credentials. Losing it makes stored credentials unrecoverable.

`CHAT2API_BOOTSTRAP_API_KEY` is environment-managed. Replacing it and restarting
atomically revokes the previous bootstrap key without changing admin-created keys.

## Verification

```bash
pnpm check
docker compose -f compose.yaml -f compose.local.yaml config
docker build --tag chat2api-web-gateway:local .
pnpm smoke:container
```

`pnpm check` runs lint, strict type checking, unit/integration tests, production
build, static security guards, and a production dependency audit. The container
smoke test generates disposable secrets and validates API/admin authentication,
CSRF, remote-media rejection, hashed key storage, metadata-only request logs,
non-root execution, read-only filesystems, dropped capabilities, and bounded
proxy trust. It never calls a provider.

## Docker

The base compose file exposes port `8080` only to the container network. The local
override binds it to loopback:

```bash
docker compose -f compose.yaml -f compose.local.yaml up --build
```

For Coolify, use `compose.yaml`, attach a persistent volume to `/data`, inject all
required environment variables through Coolify secrets, and route the domain to
port `8080`. Do not mount the Docker socket or an application source directory.

See:

- [Architecture](docs/architecture.md)
- [Security](docs/security.md)
- [Deployment](docs/deployment.md)
- [Operations](docs/operations.md)
- [Provider notes](docs/providers/README.md)

## License and attribution

Licensed under GPL-3.0. Preserve upstream copyright and license notices when
distributing this derivative.
