# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=24.22.3
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo
# better-sqlite3 13 ships prebuilt N-API binaries (musl too): no C toolchain in the builder.
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/package.json
COPY supplier/package.json ./supplier/package.json
COPY paper2agent/package.json ./paper2agent/package.json
COPY buyer/package.json ./buyer/package.json
COPY indexer/package.json ./indexer/package.json
RUN pnpm install --frozen-lockfile --filter '@marketplace/paper2agent...'
COPY packages/shared ./packages/shared
COPY supplier ./supplier
COPY paper2agent ./paper2agent
COPY contracts/marketplace/plutus.json ./contracts/marketplace/plutus.json
COPY contracts/identity-marketplace/plutus.json ./contracts/identity-marketplace/plutus.json
# Bundle the control/publisher entry into paper2agent/dist-server/ (absolute /repo paths: built and run in /repo).
COPY scripts/ci/build-service.mjs ./scripts/ci/build-service.mjs
RUN node scripts/ci/build-service.mjs paper2agent

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /repo
RUN apk add --no-cache tini docker-cli docker-cli-buildx
COPY --from=builder /repo /repo
RUN mkdir -p /repo/data/paper2agent-control /repo/data/paper2agent-publisher \
 && chown -R node:node /repo/data
USER node
ENV NODE_ENV=production
EXPOSE 8095 8096
ENTRYPOINT ["/sbin/tini", "--", "node", "--enable-source-maps", "paper2agent/dist-server/index.js"]
CMD ["control"]
