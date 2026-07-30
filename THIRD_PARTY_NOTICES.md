# Third-Party Notices

## Upstream project

Chat2API DeepSeek Web Gateway is derived from
[xiaoY233/Chat2API](https://github.com/xiaoY233/Chat2API), originally published
by the Chat2API Team under GPL-3.0. This distribution preserves the upstream
Git history, copyright notices, and GPL terms while substantially replacing the
desktop and multi-provider runtime with a web-only, DeepSeek-focused gateway.

## Runtime dependencies

This project is distributed under GPL-3.0 and includes third-party production
dependencies under compatible permissive licenses. The lockfile-reviewed
production license groups are:

- MIT
- ISC
- BSD-2-Clause
- BSD-3-Clause
- BlueOak-1.0.0
- OFL-1.1

The two self-hosted font packages, Manrope Variable and JetBrains Mono Variable,
are distributed under OFL-1.1. Runtime framework, HTTP, validation, database,
React, and icon dependencies use the permissive groups listed above.

The authoritative package names, versions, license metadata, authors, and
upstream homepages can be regenerated from the locked dependency graph:

```bash
pnpm licenses list --prod
pnpm licenses:check
```

Package-level license files remain included in `node_modules` during the
container build. Preserve those notices when redistributing the application or
its bundled assets.
