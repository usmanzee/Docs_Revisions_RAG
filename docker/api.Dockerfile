# ---------------------------------------------------------------------------
# API image.
#
# Multi-stage: the build stage carries the TypeScript toolchain and dev
# dependencies, the runtime stage carries only what is needed to serve traffic.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS build

WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# The web workspace is not needed in the API image, but npm workspaces resolve
# the whole tree, so its manifest has to be present.
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN npm run build --workspace @docs-rag/shared \
 && npm run build --workspace @docs-rag/api


FROM node:22-bookworm-slim AS runtime

# tesseract.js runs its recognition in WebAssembly and needs no system binary,
# but it does need CA certificates to fetch language data on first use.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/dist apps/api/dist

# Migrations and scripts are part of the runtime surface: the container is how
# `db:migrate`, `corpus:generate` and `ingestion:run` are executed in a
# containerised setup.
COPY migrations ./migrations
COPY scripts ./scripts
COPY apps/api/src ./apps/api/src
COPY tsconfig.base.json tsconfig.json ./

RUN mkdir -p storage/documents data/evaluation .tesseract-cache \
 && chown -R node:node /app

# Never run as root.
USER node

EXPOSE 3000

# tsx is available so the maintenance scripts can be run inside the container:
#   docker compose exec api npx tsx scripts/run-ingestion.ts
CMD ["node", "apps/api/dist/server.js"]
