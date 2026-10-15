# Mock server image (Fly.io, docs/adr/0003). Node runs the TypeScript sources directly (type
# stripping, docs/adr/0005), so there is no build step: only a production install of the server's
# dependencies. Build from the repository root, which is the context:
#
#   docker build -f apps/mock-server/Dockerfile --build-arg GIT_SHA="$(git rev-parse HEAD)" -t lsv-mock .
#   docker run --rm -p 8080:8080 -e ALLOWED_ORIGINS=http://localhost:4173 lsv-mock
#
# The root .dockerignore is an allowlist; a new workspace package or a runtime file of the server
# must be added there and here.

FROM node:24.21-slim AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_update_notifier=false
RUN corepack enable

# Manifests first, so this layer and the install stay cached until a dependency changes. Every
# workspace manifest (apps/web too) is copied so that the workspace matches the lockfile's importers;
# a filtered install tolerates missing ones today, but nothing promises that.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/mock-server/package.json apps/mock-server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
# Not `pnpm deploy`: it copies @lsv/protocol into node_modules, where Node refuses to strip types.
# A filtered install links the workspace package instead, so Node loads it from packages/protocol.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter "@lsv/mock-server..."

FROM node:24.21-slim
WORKDIR /app
ENV NODE_ENV=production
# Fly sends traffic to internal_port 8080 (fly.toml); HOST defaults to 0.0.0.0 in production.
ENV PORT=8080

# Manifests and node_modules (pnpm's relative symlinks survive the copy), without pnpm or its store.
COPY --from=deps /app ./
COPY packages/protocol/src packages/protocol/src/
COPY apps/mock-server/src apps/mock-server/src/

USER node
EXPOSE 8080
CMD ["node", "apps/mock-server/src/main.ts"]

# Last, so a new commit only rebuilds this metadata layer. Reported by /healthz as `version`.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
