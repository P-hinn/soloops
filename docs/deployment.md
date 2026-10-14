# Deploying on a small server

Sized for the machine that also runs the portfolio: **2 cores, 1.92 GB RAM,
port 3000 taken**. `docker-compose.prod.yml` is a standalone compose file, not
an override.

```bash
cp .env.example .env       # fill in, set NODE_ENV=production and APP_URL
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api npm -w @soloops/api run seed
```

What differs from development:

|            | Development                        | Production                                 |
| ---------- | ---------------------------------- | ------------------------------------------ |
| Web        | Vite dev server (`tsx watch`, HMR) | static bundle behind nginx                 |
| Open ports | 5174 web, 3000 API, 5433 Postgres  | exactly one: `SOLOOPS_PORT` (8090 default) |
| Source     | mounted from the host              | baked into the image                       |
| Node       | `tsx watch`                        | `tsx`, `NODE_OPTIONS=--max-old-space-size` |

nginx serves the bundle and proxies `/api` and `/health` to the API — the API
itself has no port exposed, and neither do Postgres and Redis. `SOLOOPS_PORT`
is deliberately **not** 3000; a reverse proxy with TLS belongs in front of it.
All the operational commands above — logs, backup, restore — apply here too,
just with `-f docker-compose.prod.yml`.

## Memory

Per-service limits (`mem_limit`) and what is actually used at idle:

| Service     | Limit       | Measured (idle) |
| ----------- | ----------- | --------------- |
| api         | 384 MB      | 138 MB          |
| worker      | 320 MB      | 103 MB          |
| postgres    | 320 MB      | 32 MB           |
| redis       | 96 MB       | 11 MB           |
| web (nginx) | 64 MB       | 10 MB           |
| **Total**   | **1184 MB** | **294 MB**      |

Postgres runs with `shared_buffers=96MB` and `max_connections=30` instead of
the defaults, which assume considerably more RAM. Redis is capped at 64 MB with
`maxmemory-policy noeviction` — BullMQ jobs should fail loudly and show up in
the log when memory runs out, not disappear quietly.

The bottleneck is not running it, it is the **build**: `npm install` plus the
Vite build on two cores. The web build therefore runs `build:only` (without
`vue-tsc`, which runs in `npm run check`) with a capped heap. If the build is
still tight on the server, add swap first, or build the image on your
development machine and push it to a registry.
