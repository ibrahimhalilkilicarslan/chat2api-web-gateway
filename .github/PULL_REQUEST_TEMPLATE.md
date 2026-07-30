## Summary

Describe the problem and the smallest change that solves it.

## Security boundary

- [ ] No credentials, cookies, prompts, completions, or provider payloads are persisted or logged.
- [ ] Authentication remains fail-closed.
- [ ] No arbitrary upstream URL, remote media, Docker socket, or privileged runtime access was added.
- [ ] New inputs are validated and bounded.

## Verification

- [ ] `pnpm check`
- [ ] Relevant container or compatibility smoke
- [ ] Documentation updated

## Evidence

List tests, safe screenshots, and any manual verification. Do not attach secrets
or real request content.
