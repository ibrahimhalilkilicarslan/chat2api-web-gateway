# Contributing

## Development

```bash
corepack enable
corepack prepare pnpm@11.18.0 --activate
pnpm install --frozen-lockfile
pnpm setup -- --origin http://localhost:8080
pnpm check
```

## Rules

- Preserve the web-only, DeepSeek-only product boundary.
- Never add secrets, cookies, provider payloads, prompts, or completions to logs.
- Never weaken fail-closed authentication or container isolation.
- Add tests for authentication, validation, encryption, quotas, failover, and
  redaction changes.
- Document new environment variables and deployment behavior.
- Do not claim provider compatibility without controlled JSON and SSE smoke
  evidence.

Before submitting a change, include the commands run, test results, operational
risk, and any manual provider verification still required.
