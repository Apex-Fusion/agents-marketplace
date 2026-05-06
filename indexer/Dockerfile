# syntax=docker/dockerfile:1.7
#
# indexer/Dockerfile — multi-stage image for the chain-follower indexer.
#
# Notes:
#   - better-sqlite3 has native components and needs python3 + make + g++ to
#     build during `pnpm install`. We install them in the builder stage only
#     and ship the prebuilt binding to the runtime image (no toolchain in
#     prod).
#   - We tried node:20-alpine first; better-sqlite3 11.x ships prebuilds for
#     musl on linux/x64 so it works without a fallback. If a future version
#     drops musl prebuilds, switch BUILDER_IMAGE to node:20-bookworm-slim and
#     replace `apk add` with `apt-get install -y python3 make g++`.
#   - Same tsx-based runtime as supplier (see supplier/Dockerfile for the
#     rationale: shared package exports .ts directly).
#
# Build:
#   docker build -f indexer/Dockerfile -t marketplace-indexer .

ARG NODE_VERSION=20.19.0

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

# Toolchain for native modules (better-sqlite3). These do NOT land in runtime.
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY indexer/package.json ./indexer/package.json
COPY indexer-ui/package.json ./indexer-ui/package.json
COPY buyer/package.json ./buyer/package.json
COPY supplier/package.json ./supplier/package.json

# Install both the indexer (chain follower / API) AND the indexer-ui (Vite/React
# bundle) so the multi-stage build can produce a self-hosted dashboard image.
RUN pnpm install --frozen-lockfile --filter '@marketplace/indexer...' --filter '@marketplace/indexer-ui...'

# better-sqlite3 has native bindings. pnpm 10's "approve-builds" gate skips
# postinstall on native modules by default. Explicitly fetch the prebuilt
# binary into build/Release/. Match Catherine's M1-D-green diagnosis (the
# .node file lands at .pnpm/better-sqlite3@*/.../build/Release/).
RUN BSQ_DIR=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1) \
 && [ -n "$BSQ_DIR" ] || (echo "FATAL: better-sqlite3 not in pnpm store" && exit 1) \
 && echo "rebuilding native binding at: $BSQ_DIR" \
 && (cd "$BSQ_DIR" && (npx --yes prebuild-install --runtime=node || npm install --build-from-source --no-save)) \
 && ls -la "$BSQ_DIR/build/Release/better_sqlite3.node"

COPY packages/shared ./packages/shared
COPY indexer ./indexer
COPY indexer-ui ./indexer-ui

# Build the indexer-ui dashboard. Output lands at indexer-ui/dist/ which the
# runtime image will serve via express.static when INDEXER_UI_DIST is set.
RUN pnpm --filter @marketplace/indexer-ui build

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
CMD ["node_modules/.bin/tsx", "indexer/src/index.ts"]
