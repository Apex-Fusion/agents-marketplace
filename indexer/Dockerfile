# syntax=docker/dockerfile:1.7
#
# indexer/Dockerfile — multi-stage image for the chain-follower indexer.
#
# Notes:
#   - better-sqlite3 13 ships prebuilt N-API binaries, also for musl on
#     linux/x64, so the builder needs no C toolchain and pnpm skips its build
#     script (ignoredBuiltDependencies in pnpm-workspace.yaml).
#   - The image runs an esbuild bundle of the server (indexer/dist-server/,
#     scripts/ci/build-service.mjs), which includes @marketplace/shared (it
#     exports .ts files). No tsx at runtime.
#
# Build:
#   docker build -f indexer/Dockerfile -t marketplace-indexer .

ARG NODE_VERSION=24.22.3

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

# No C toolchain: better-sqlite3 13 has a prebuilt musl binary.

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
# pnpm-lock.yaml's patchedDependencies hash the patch files at install time.
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/package.json
COPY indexer/package.json ./indexer/package.json
COPY indexer-ui/package.json ./indexer-ui/package.json
COPY buyer/package.json ./buyer/package.json
COPY supplier/package.json ./supplier/package.json

# Install both the indexer (chain follower / API) AND the indexer-ui (Vite/React
# bundle) so the multi-stage build can produce a self-hosted dashboard image.
RUN pnpm install --frozen-lockfile --filter '@marketplace/indexer...' --filter '@marketplace/indexer-ui...'

# better-sqlite3 13 loads its prebuilt musl binary; pnpm skips its build script.

COPY packages/shared ./packages/shared
COPY indexer ./indexer
COPY indexer-ui ./indexer-ui

# Build the indexer-ui dashboard. Output lands at indexer-ui/dist/ which the
# runtime image will serve via express.static when INDEXER_UI_DIST is set.
RUN pnpm --filter @marketplace/indexer-ui build

# Bundle the server into indexer/dist-server/: the image runs no tsx. The bundle holds absolute /repo paths.
COPY scripts/ci/build-service.mjs ./scripts/ci/build-service.mjs
RUN node scripts/ci/build-service.mjs indexer

# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /repo

RUN apk add --no-cache tini

COPY --from=builder /repo /repo

# SQLite data dir — mounted as a named volume in compose.
RUN mkdir -p /repo/indexer/data && chown -R node:node /repo
USER node

ENV NODE_ENV=production
ENV INDEXER_PORT=8090
ENV DB_PATH=/repo/indexer/data/indexer.db
# Auto-mount the bundled dashboard in the runtime image. Override with empty
# string ("") to run API-only.
ENV INDEXER_UI_DIST=/repo/indexer-ui/dist
EXPOSE 8090

# Indexer health endpoint is /healthz (standardized 2026-04-27 across all
# services — see indexer/src/routes/healthz.ts and ARCHITECTURE.md §5).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${INDEXER_PORT}/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "indexer/dist-server/index.js"]
