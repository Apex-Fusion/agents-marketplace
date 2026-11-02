# syntax=docker/dockerfile:1.7
#
# identity-gateway/Dockerfile: the did:vector resolver (also the Universal Resolver driver image).
#
# The build context is the repository root, because the image installs through the pnpm workspace:
#   docker build -f identity-gateway/Dockerfile -t identity-gateway:<version> .
#
# Stages: `build` compiles TypeScript to identity-gateway/dist; `production-dependencies` installs
# only the runtime dependencies; `runtime` holds both, runs as the non-root `node` user and listens
# on 0.0.0.0:8080.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-alpine AS workspace
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
# pnpm-lock.yaml's patchedDependencies hash the patch files at install time.
COPY patches ./patches
COPY identity-gateway/package.json ./identity-gateway/package.json

FROM workspace AS build
RUN pnpm install --frozen-lockfile --filter identity-gateway --ignore-scripts
COPY identity-gateway ./identity-gateway
RUN pnpm --filter identity-gateway build

FROM workspace AS production-dependencies
RUN pnpm install --frozen-lockfile --prod --filter identity-gateway --ignore-scripts

FROM node:${NODE_VERSION}-alpine AS runtime
RUN apk add --no-cache tini
WORKDIR /app
COPY --from=production-dependencies /repo/node_modules ./node_modules
COPY --from=production-dependencies /repo/identity-gateway/node_modules ./identity-gateway/node_modules
COPY --from=build /repo/identity-gateway/dist ./identity-gateway/dist
COPY identity-gateway/package.json identity-gateway/LICENSE ./identity-gateway/

LABEL org.opencontainers.image.source="https://github.com/Apex-Fusion/agents-marketplace" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="did:vector resolver"

USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "identity-gateway/dist/main.js"]
