# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS build

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:${PATH}"
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.17.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --frozen-lockfile

COPY tsconfig*.json tsup.config.ts vite.config.ts vitest.config.ts eslint.config.js ./
COPY scripts ./scripts
COPY src ./src
COPY sha3_wasm_bg.7b9ca65ddd.wasm ./

RUN pnpm lint \
  && pnpm typecheck \
  && pnpm test \
  && pnpm build \
  && pnpm security:check \
  && pnpm prune --prod

FROM node:22.22.2-bookworm-slim@sha256:9f6d5975c7dca860947d3915877f85607946403fc55349f39b4bc3688448bb6e AS runtime

ENV NODE_ENV=production
ENV CHAT2API_HOST=0.0.0.0
ENV PORT=8080
ENV CHAT2API_DATABASE_PATH=/data/chat2api.sqlite
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 chat2api \
  && useradd --uid 10001 --gid chat2api --home-dir /nonexistent --shell /usr/sbin/nologin chat2api \
  && install -d -o chat2api -g chat2api -m 0700 /data

COPY --from=build --chown=root:root /app/package.json ./package.json
COPY --from=build --chown=root:root /app/node_modules ./node_modules
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/scripts/backup-sqlite.mjs ./scripts/backup-sqlite.mjs

USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/bootstrap.js"]
