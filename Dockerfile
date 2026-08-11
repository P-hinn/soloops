# Ein Image für alle Node-Workspaces (api, worker, web, mcp).
# Der jeweilige Startbefehl kommt aus docker-compose.yml.
FROM node:22-bookworm-slim

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
