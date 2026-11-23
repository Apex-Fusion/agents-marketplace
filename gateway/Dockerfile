# syntax=docker/dockerfile:1.7
#
# gateway/Dockerfile — multi-stage image for the OpenAI-compatible gateway.
#
# Like buyer/Dockerfile, the image runs an esbuild bundle of the server
# (gateway/dist-server/index.js, scripts/ci/build-service.mjs), which includes
# @marketplace/shared and @marketplace/buyer (both export .ts files). The
# gateway reuses the buyer's Marketplace SDK + lucid (buildAcceptTx /
# buildWithdrawTx), so it needs the libsodium patch and the
# contracts/marketplace/plutus.json blueprint.
#
# Build:
#   docker build -f gateway/Dockerfile -t marketplace-gateway .

ARG NODE_VERSION=24.22.3

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

# better-sqlite3 13 ships prebuilt N-API binaries (musl too), so the builder needs no C toolchain.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
# pnpm-lock.yaml's patchedDependencies hash the patch files at install time.
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/package.json
COPY buyer/package.json ./buyer/package.json
COPY gateway/package.json ./gateway/package.json

# Install the gateway and its workspace deps (buyer + shared) with their deps.
RUN pnpm install --frozen-lockfile --filter '@marketplace/gateway...'

# better-sqlite3 13 loads its prebuilt musl binary; pnpm skips its build script (ignoredBuiltDependencies).

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
# loadIdentityBlueprint reads the new escrow (settle, sweeper, RefundRevoked).
COPY contracts/identity-marketplace/plutus.json ./contracts/identity-marketplace/plutus.json

# Bundle the server into gateway/dist-server/: the image runs no tsx. The bundle holds absolute /repo paths.
COPY scripts/ci/build-service.mjs ./scripts/ci/build-service.mjs
RUN node scripts/ci/build-service.mjs gateway

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
CMD ["node", "--enable-source-maps", "gateway/dist-server/index.js"]
