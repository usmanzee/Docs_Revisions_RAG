# ---------------------------------------------------------------------------
# Web image.
#
# Builds the static bundle, then serves it from nginx with a reverse proxy to
# the API. Serving both from one origin means the browser never makes a
# cross-origin request, and no API address has to be compiled into the bundle.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

RUN npm run build --workspace @docs-rag/shared \
 && npm run build --workspace @docs-rag/web


FROM nginx:1.27-alpine AS runtime

ARG API_ORIGIN=http://api:3000
ENV API_ORIGIN=${API_ORIGIN}

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80
