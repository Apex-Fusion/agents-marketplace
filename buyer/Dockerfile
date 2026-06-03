# syntax=docker/dockerfile:1.7
#
# buyer/Dockerfile — multi-stage image for the buyer Express + React app.
#
# Two artifacts produced:
#   1. Vite-built static UI bundle at  buyer/dist/{index.html, assets/...}
#   2. tsx-runnable Express server at  buyer/src/index.ts
#
# The Express server (buyer/src/index.ts:78) reads
#   resolve(process.cwd(), "buyer/dist")
# at boot and serves that directory, so we set the runtime WORKDIR to /repo
# (the repo root, since the path is "buyer/dist" not "./dist") and ensure the
# Vite output lands there.
#
# We do NOT run `tsc` for the server because @marketplace/shared exports .ts
# files directly via package.json#exports — the tsx loader handles them. The
# buyer's tsconfig.json#outDir of "./dist" would in fact COLLIDE with the
# Vite outDir if both were run, since vite.config.ts has emptyOutDir:true and
# would wipe any tsc-emitted index.js. tsx-only runtime avoids this trap.
#
# Build:
#   docker build -f buyer/Dockerfile -t marketplace-buyer .

ARG NODE_VERSION=20.19.0

# ─── builder ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo

# better-sqlite3 (used by the response archive) ships native bindings —
# python3 + make + g++ are needed during pnpm install for the prebuild
# install / fallback compile. Toolchain stays in the BUILDER stage only.
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY buyer/package.json ./buyer/package.json
COPY supplier/package.json ./supplier/package.json
COPY indexer/package.json ./indexer/package.json

# Buyer needs vite + tailwind + react devDeps to build the UI bundle, so we
# must install with dev deps included (default).
RUN pnpm install --frozen-lockfile --filter '@marketplace/buyer...'

# better-sqlite3 native binding fetch (mirrors indexer/Dockerfile). pnpm 10's
# approve-builds gate skips the postinstall on native modules, so we manually
# resolve the binary into build/Release/.
RUN BSQ_DIR=$(ls -d node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 2>/dev/null | head -1) \
 && [ -n "$BSQ_DIR" ] || (echo "FATAL: better-sqlite3 not in pnpm store" && exit 1) \
 && echo "rebuilding native binding at: $BSQ_DIR" \
 && (cd "$BSQ_DIR" && (npx --yes prebuild-install --runtime=node || npm install --build-from-source --no-save)) \
 && ls -la "$BSQ_DIR/build/Release/better_sqlite3.node"

# libsodium-wrappers-sumo (transitive via @lucid-evolution/lucid → CML) does
# `import "./libsodium-sumo.mjs"` from its wrapper, but pnpm's strict store
# layout puts the .mjs in a sibling pkg, breaking the relative import. Patch
# by copying the file into the wrapper's expected path. Same fix as the
# supplier Dockerfile — required now that the buyer's /v1/accept endpoint
# goes through buildAcceptTx → buildLiveTxForAccept → lucid.
RUN set -e \
 && SRC=$(find node_modules/.pnpm -name "libsodium-sumo.mjs" -path "*/libsodium-sumo/dist/*" 2>/dev/null | head -1) \
 && DST=$(find node_modules/.pnpm -type d -path "*libsodium-wrappers-sumo@*/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm" 2>/dev/null | head -1) \
 && [ -n "$SRC" ] && [ -n "$DST" ] || (echo "FATAL: libsodium-sumo paths not resolved" && exit 1) \
 && cp "$SRC" "$DST/" \
 && echo "patched libsodium wrapper: $DST/libsodium-sumo.mjs"

COPY packages/shared ./packages/shared
COPY buyer ./buyer
# loadBlueprint at runtime reads contracts/marketplace/plutus.json to derive
# the escrow script address + attach the spending validator script in
# buildLiveTxForAccept. Same as the supplier image.
COPY contracts/marketplace/plutus.json ./contracts/marketplace/plutus.json

# Build the static UI into buyer/dist (Vite outDir is buyer/dist;
# emptyOutDir:true is fine here because we run this exactly once).
RUN pnpm --filter @marketplace/buyer build:ui

# ─── runtime ──────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /repo

RUN apk add --no-cache tini

# Copy the entire workspace incl. node_modules. This includes the buyer/dist
# Vite bundle that the Express server will static-serve.
COPY --from=builder /repo /repo

# Pre-create the archive dir (ARCHIVE_DIR / default ./data/archive) owned by
# `node` BEFORE chown. When a fresh named volume is mounted here, Docker seeds
# the empty volume from this image directory and inherits its node ownership —
# otherwise the volume mounts root-owned and the non-root `node` process can't
# open the SQLite archive / pdf-jobs.db.
RUN mkdir -p /repo/data/archive && chown -R node:node /repo
USER node

ENV NODE_ENV=production
ENV BUYER_PORT=8070
EXPOSE 8070

# Buyer health endpoint is /healthz (see buyer/src/server.ts:26).
HEALTHCHECK --interval=20s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${BUYER_PORT}/healthz >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "buyer/src/index.ts"]
