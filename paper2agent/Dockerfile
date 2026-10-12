# syntax=docker/dockerfile:1.7
ARG NODE_VERSION=20.20.2
FROM node:${NODE_VERSION}-alpine AS builder
WORKDIR /repo
RUN apk add --no-cache python3 make g++
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

FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /repo
RUN apk add --no-cache tini docker-cli docker-cli-buildx
COPY --from=builder /repo /repo
RUN mkdir -p /repo/data/paper2agent-control /repo/data/paper2agent-publisher \
 && chown -R node:node /repo/data
USER node
ENV NODE_ENV=production
EXPOSE 8095 8096
ENTRYPOINT ["/sbin/tini", "--", "node_modules/.bin/tsx", "paper2agent/src/index.ts"]
CMD ["control"]
