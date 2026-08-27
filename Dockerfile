# Ein Image für alle Node-Workspaces (api, worker, web, mcp).
# Der jeweilige Startbefehl kommt aus docker-compose.yml.
#
# Stufen:
#   base       Node + alle Workspaces + generierter Prisma-Client. Die
#              Entwicklungs-Compose mountet den Quellcode darüber.
#   web-build  baut das Vue-Bundle nach apps/web/dist
#   web        nginx, liefert das Bundle aus und proxyt /api an die API
#   runtime    schlanke Laufzeit für api/worker/mcp im Produktivbetrieb

FROM node:22-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates fontconfig curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Nur die Manifeste kopieren -> npm-Layer bleibt gecached
COPY package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/mcp/package.json apps/mcp/

RUN npm install

COPY . .

RUN npx prisma generate --schema apps/api/prisma/schema.prisma

ENV NODE_ENV=development
EXPOSE 3000 5173


# --- Web-Bundle ------------------------------------------------------------
# `build:only` statt `build`: vue-tsc braucht mehr Speicher als ein kleiner
# Server hat, und der Typecheck läuft ohnehin in `npm run check`.
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
