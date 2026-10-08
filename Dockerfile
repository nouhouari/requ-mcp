# syntax=docker/dockerfile:1.7
#
# requ-mcp production image — HTTP MCP server + web dashboard on :8788.
#
#   docker build -t requ-mcp .
#   docker run --rm -p 8788:8788 -e REQU_PG_URL=postgresql://… requ-mcp
#
# Two stages keep the runtime image small and free of compilers:
#   build   — full install, TypeScript compile (+ OpenAPI regen), then prune
#             to production dependencies. better-sqlite3 is a native module,
#             so the toolchain lives here in case no prebuilt binary matches.
#   runtime — node + pruned deps + dist only, running as the unprivileged
#             `node` user
#
# The package.json `prepare` script runs tsc on every install, which is why a
# separate `npm ci --omit=dev` stage cannot work: tsc is a dev dependency.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json tsconfig.json ./
# prepare needs src/ to compile; install with scripts off, build explicitly.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm rebuild better-sqlite3
COPY src ./src
COPY scripts ./scripts
RUN npm run build \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    REQU_HOST=0.0.0.0 \
    REQU_PORT=8788

# dist/index.js resolves ../package.json at runtime for the server version.
COPY --chown=node:node package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/openapi ./openapi

# Read-only mount point for the repos requ inspects (see docker-compose.yml),
# and a writable location for SQLite stores when REQU_PG_URL is not set.
RUN mkdir -p /workspace /data && chown node:node /workspace /data
VOLUME ["/data"]

USER node
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${REQU_PORT}/api/version" >/dev/null || exit 1

CMD ["node", "dist/index.js"]
