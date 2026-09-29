# One image for every Node workspace (api, worker, web, mcp).
# The start command for each comes from docker-compose.yml.
#
# Stages:
#   base       Node + all workspaces + a generated Prisma client. The
#              development compose mounts the source on top of it.
#   web-build  builds the Vue bundle into apps/web/dist
#   web        nginx, serves the bundle and proxies /api to the API
#   runtime    a lean runtime for api/worker/mcp in production

FROM node:22-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates fontconfig curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the manifests only -> the npm layer stays cached
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/mcp/package.json apps/mcp/

# Clear the cache in the same layer — otherwise ~900 MB of tarballs remain
RUN npm install && npm cache clean --force

COPY . .

RUN npx prisma generate --schema apps/api/prisma/schema.prisma

ENV NODE_ENV=development
EXPOSE 3000 5173


# --- Web bundle ------------------------------------------------------------
# `build:only` instead of `build`: vue-tsc needs more memory than a small
# server has, and the type check runs in `npm run check` anyway.
FROM base AS web-build
RUN NODE_OPTIONS=--max-old-space-size=768 npm -w @soloops/web run build:only


FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80


# --- API / Worker / MCP ----------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production
EXPOSE 3000
