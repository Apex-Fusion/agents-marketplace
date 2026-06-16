# syntax=docker/dockerfile:1.7
#
# wallet-monitor/Dockerfile — image for the one-shot wallet-balance alerter.
#
# Same multi-stage tsx strategy as supplier/Dockerfile: install workspace deps
# in a builder stage, ship source + node_modules to a slim runtime stage, run
# the entry point with tsx (we do NOT compile ahead-of-time because
# @marketplace/shared exports .ts via package.json#exports — see supplier/Dockerfile).
#
# This is NOT a long-running server: there is no HEALTHCHECK / EXPOSE. It's
# invoked one-shot by cron: `docker compose -f deploy/mainnet/docker-compose.wallet-monitor.yml run --rm wallet-monitor`.
#
# Build context MUST be the repo root so pnpm can resolve workspace deps:
#   docker build -f wallet-monitor/Dockerfile -t marketplace-wallet-monitor .

ARG NODE_VERSION=20.19.0

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

# pnpm via corepack — lockfile pins pnpm@10.33.2.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# Workspace manifests first to maximise layer cache reuse. pnpm-lock.yaml indexes
# the whole workspace, so every package's manifest must be present even though
# --filter only installs what wallet-monitor needs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY wallet-monitor/package.json ./wallet-monitor/package.json
COPY buyer/package.json ./buyer/package.json
COPY supplier/package.json ./supplier/package.json
COPY indexer/package.json ./indexer/package.json

# Install only what wallet-monitor needs (+ its transitive workspace deps, i.e.
# @marketplace/shared and the chain stack).
RUN pnpm install --frozen-lockfile --filter '@marketplace/wallet-monitor...'

# libsodium-wrappers-sumo patch — @marketplace/shared/chain re-exports
# LiveOgmiosProvider, which pulls @lucid-evolution/lucid → CML → the broken
# relative `import "./libsodium-sumo.mjs"`. Copy the file into the wrapper's
# expected path. Identical to supplier/Dockerfile. ARCHITECTURE.md §9 #16.
RUN set -e \
 && SRC=$(find node_modules/.pnpm -name "libsodium-sumo.mjs" -path "*/libsodium-sumo/dist/*" 2>/dev/null | head -1) \
 && DST=$(find node_modules/.pnpm -type d -path "*libsodium-wrappers-sumo@*/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm" 2>/dev/null | head -1) \
 && [ -n "$SRC" ] && [ -n "$DST" ] || (echo "FATAL: libsodium-sumo paths not resolved" && exit 1) \
 && cp "$SRC" "$DST/" \
 && echo "patched libsodium wrapper: $DST/libsodium-sumo.mjs"

# Copy the actual source — shared + wallet-monitor.
COPY packages/shared ./packages/shared
COPY wallet-monitor ./wallet-monitor

# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /repo

# tini for signal-forwarding (graceful SIGTERM → process.exit).
RUN apk add --no-cache tini

COPY --from=builder /repo /repo

# Run as root (the default for this image): the one-shot writes its dedup state
# to a bind-mounted host dir (/repo/wallet-monitor/data), which is typically
# root-owned on the box. No ports, no privileges to drop for a server.
ENV NODE_ENV=production

# tsx is hoisted to /repo/node_modules/.bin by pnpm — invoke via the workspace bin.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "wallet-monitor/src/index.ts"]
