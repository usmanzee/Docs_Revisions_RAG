# ---------------------------------------------------------------------------
# Mock HCM leave service.
#
# Deliberately its own image and its own container: it stands in for a system
# owned by someone else, and packaging it with the API would blur exactly the
# boundary it exists to model.
# ---------------------------------------------------------------------------

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/hcm-contract/package.json packages/hcm-contract/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/hcm-mock/package.json apps/hcm-mock/

RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY packages/hcm-contract packages/hcm-contract
COPY apps/hcm-mock apps/hcm-mock

RUN npm run build --workspace @docs-rag/hcm-contract \
 && npm run build --workspace @docs-rag/hcm-mock


FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/hcm-contract/package.json packages/hcm-contract/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/hcm-mock/package.json apps/hcm-mock/

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=build /app/packages/hcm-contract/dist packages/hcm-contract/dist
COPY --from=build /app/apps/hcm-mock/dist apps/hcm-mock/dist

RUN mkdir -p data && chown -R node:node /app
USER node

EXPOSE 3100

CMD ["node", "apps/hcm-mock/dist/server.js"]
