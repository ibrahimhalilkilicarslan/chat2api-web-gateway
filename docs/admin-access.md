# Admin Access

The public OpenAI-compatible API and the admin console may share one hostname,
but a separate admin hostname behind an identity-aware proxy is preferred.

## Application boundary

`CHAT2API_ADMIN_ORIGINS` controls browser origins allowed to create and mutate
admin sessions. `CHAT2API_ADMIN_HOSTS` independently controls which exact
request hostnames may reach any `/admin` route. Both are comma-separated exact
values.

```dotenv
CHAT2API_ADMIN_ORIGINS=https://admin.gateway.example.com
CHAT2API_ADMIN_HOSTS=admin.gateway.example.com
```

Requests for `/admin` on another hostname receive a generic `404`; API and
health routes remain available according to their own authentication rules.
Do not include schemes, ports, paths, wildcards, or credentials in
`CHAT2API_ADMIN_HOSTS`.

## Recommended edge policy

1. Route `api.gateway.example.com` to the gateway for `/v1/*` and health checks.
2. Route `admin.gateway.example.com` to the same service.
3. Put the complete admin hostname behind Cloudflare Access, Tailscale, or an
   equivalent identity-aware proxy with MFA.
4. Keep the gateway admin token as a second application-level factor.
5. Preserve the real client address through exactly the trusted proxy hop count
   configured by `CHAT2API_TRUST_PROXY`.

The application hostname restriction is defense in depth, not a replacement for
edge authentication. Do not expose a second container port or mount the Docker
socket.

## Verification

```bash
curl -sS -o /dev/null -w '%{http_code}\n' \
  https://api.gateway.example.com/admin/
# expected: 404

curl -sS -o /dev/null -w '%{http_code}\n' \
  https://admin.gateway.example.com/admin/
# expected after edge authentication: 200
```

Also verify that an unlisted `Origin` cannot log in, cross-origin admin
mutations fail, and `/v1/models` remains Bearer-authenticated.
