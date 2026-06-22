# syntax=docker/dockerfile:1.7
#
# gateway/Dockerfile — multi-stage image for the OpenAI-compatible gateway.
#
# Mirrors buyer/Dockerfile: we do NOT run `tsc` for the server because
# @marketplace/shared and @marketplace/buyer export .ts directly via
# package.json#exports — the tsx loader handles them at runtime. The gateway
# reuses the buyer's Marketplace SDK + lucid (buildAcceptTx / buildWithdrawTx),
# so it needs the same better-sqlite3 native rebuild + libsodium patch and the
# contracts/marketplace/plutus.json blueprint.
#
# Build:
#   docker build -f gateway/Dockerfile -t marketplace-gateway .

ARG NODE_VERSION=20.19.0

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

RUN apk add --no-cache python3 make g++
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY buyer/package.json ./buyer/package.json
COPY gateway/package.json ./gateway/package.json

# Install the gateway and its workspace deps (buyer + shared) with their deps.
RUN pnpm install --frozen-lockfile --filter '@marketplace/gateway...'

# better-sqlite3 native binding (same step as buyer/indexer images).
RUN BSQ_DIR=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1) \
 && [ -n "$BSQ_DIR" ] || (echo "FATAL: better-sqlite3 not in pnpm store" && exit 1) \
 && (cd "$BSQ_DIR" && (npx --yes prebuild-install --runtime=node || npm install --build-from-source --no-save)) \
 && ls -la "$BSQ_DIR/build/Release/better_sqlite3.node"

# libsodium wrapper patch (lucid/CML dep) — same fix as the buyer image.
RUN set -e \
 && SRC=$(find node_modules/.pnpm -name "libsodium-sumo.mjs" -path "*/libsodium-sumo/dist/*" 2>/dev/null | head -1) \
 && DST=$(find node_modules/.pnpm -type d -path "*libsodium-wrappers-sumo@*/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm" 2>/dev/null | head -1) \
 && [ -n "$SRC" ] && [ -n "$DST" ] || (echo "FATAL: libsodium-sumo paths not resolved" && exit 1) \
 && cp "$SRC" "$DST/"

COPY packages/shared ./packages/shared
COPY buyer ./buyer
COPY gateway ./gateway
# loadBlueprint reads contracts/marketplace/plutus.json at runtime (Accept/Withdraw).
COPY contracts/marketplace/plutus.json ./contracts/marketplace/plutus.json

# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /repo

RUN apk add --no-cache tini
COPY --from=builder /repo /repo

# Seed the gateway DB dir owned by node (so a fresh named volume inherits it).
RUN mkdir -p /repo/data/gateway && chown -R node:node /repo
USER node

ENV NODE_ENV=production
ENV GATEWAY_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${GATEWAY_PORT}/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "gateway/src/index.ts"]
