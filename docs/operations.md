# Operations

```bash
docker compose logs -f api worker    # logs
docker compose exec api npm -w @soloops/api run db:studio   # Prisma Studio
docker compose down                  # stop
npm run ports                        # who is listening on what right now?
npm run ports:kill soloops           # free this project's ports
```

`npm run ports` lists every listening service with its process and origin —
the container name where there is one, otherwise the working directory.
Freeing knows the difference: a port held by Docker is released by stopping the
container rather than by killing the daemon.

## Schema changes

Edit `prisma/schema.prisma`, then `npm run db:migrate` — that writes a
migration under `prisma/migrations/`, applies it, and regenerates the client.
Commit the migration with the schema change; the two belong together and a
schema without its migration is a schema nobody else can apply.

On every start a one-shot `migrate` service runs `prisma migrate deploy` and
`api` and `worker` wait for it to finish. So a container restart applies
whatever is pending, and a migration that fails stops the boot instead of
becoming the first line of a log nobody reads.

`prisma db push` is gone. It was convenient and it could silently drop a
column; `migrate deploy` only ever runs what is written down and reviewed.

### Taking over a database that predates the migrations

The first migration, `0_init`, is the whole schema as it stood when migrations
were introduced. On an existing database its tables are already there, so it
must be marked as applied **once** instead of being run:

```bash
docker compose run --rm migrate npx prisma migrate resolve --applied 0_init \
  --schema packages/core/prisma/schema.prisma
```

Without this, `migrate deploy` tries to create tables that exist and stops.
Afterwards `docker compose up` works as usual. Take a backup first — the
backup window of the macOS app does it in one click, see
[macOS app](macos-app.md).

## Configuration

Two kinds, in two places.

The `.env` holds what a container needs before it can answer anything:
`DATABASE_URL`, `REDIS_URL`, the ports, `NODE_ENV`, `TZ`, `APP_URL`,
`DATA_DIR`, `SYNC_ADVERTISE_HOSTS`, the n8n topology, `OWNER_*` (read once as
a seed), `SERVICE_TOKEN` — and **`JWT_SECRET`**, which can never move:
[`secretbox.ts`](../packages/core/src/services/secretbox.ts) derives the
encryption key from it, so a `JWT_SECRET` in the database would encrypt its
own decryption key.

Everything that belongs to the person rather than to the deployment is in
_Einstellungen_: the twelve sender fields, the five invoicing defaults, the
keys for the optional services, the video provider, and the six poll
intervals. The registry is
[`packages/core/src/settings.ts`](../packages/core/src/settings.ts); each key
carries a Zod schema, whether it is a secret, and the `.env` variable it falls
back to.

Reading order is **database → `.env` → default**. So an existing installation
keeps working untouched, and the moment a value is set in the interface the
database is the answer — editing the file has no effect from then on. Every
field in the interface says which of the two it currently is.

Secrets are sealed at rest and never sent back; the interface shows "set" and
the first four characters. Clearing a field hands it back to the `.env`.

A changed poll interval takes effect within a minute: the worker compares what
it has planned against what is in force and rewrites only what moved.

### What a JWT_SECRET rotation costs

Everything sealed with it becomes unreadable: IMAP passwords, Google refresh
tokens, CalDAV passwords, the n8n key, and now the service keys. Each site
degrades differently — some fall back to the `.env`, some ask for the value
again, `imap.ts` throws. There is no re-key path. Rotating it means entering
those secrets again, and that is worth knowing before rather than after.

Every environment variable is documented in
[`.env.example`](../.env.example); [`packages/core/src/env.ts`](../packages/core/src/env.ts) is
the authoritative source with types and defaults. If something required is
missing, the API refuses to start and says what.

## Backup

Two things have to come along: the database and `./data` (invoice PDFs, signed
contracts and the files filed at a customer). The
`.env` belongs in your password manager, not in the backup archive.

```bash
# Back up
docker compose exec -T postgres pg_dump -U soloops -Fc soloops > soloops-$(date +%F).dump
tar czf soloops-data-$(date +%F).tar.gz data/

# Restore
docker compose exec -T postgres pg_restore -U soloops -d soloops --clean --if-exists < soloops-2026-01-01.dump
```

Calendar sync is **not** a backup: it propagates changes, deletions included.
And `allowRemoteDelete` is off per account by default so a misclick here does
not take the events on all your devices with it.

## Troubleshooting

| Symptom                                | Cause and fix                                                                     |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| API won't start, log names a variable  | A required field in `.env` is missing or too short (`JWT_SECRET` needs 16+ chars) |
| Login fails although `.env` is correct | The seed never ran: `docker compose exec api npm -w @soloops/api run seed`        |
| Events missing from the week view      | Account just connected? The first sync only fetches the window — check `worker`   |
| CalDAV reports an authentication error | Apple needs an app-specific password, not the Apple ID password                   |
| Web loads, API answers 502             | The API is still waiting for `migrate`; `docker compose logs -f migrate api`      |
| Day band stays empty                   | Activity recording is off, or macOS has not been granted Accessibility            |

## Upgrading an existing installation

In this order. Only the first step is mandatory; the rest is what changed
around it.

1. **Take a backup.** The backup window of the macOS app does it in one click,
   see [macOS app](macos-app.md).

2. **Adopt the migrations — once.** `0_init` is the whole schema as it stood
   when migrations were introduced, and on an existing database its tables are
   already there:

   ```bash
   docker compose run --rm migrate npx prisma migrate resolve --applied 0_init \
     --schema packages/core/prisma/schema.prisma
   ```

   Without this, `migrate deploy` tries to create tables that exist and stops.

3. **`docker compose up -d`.** A one-shot `migrate` service now runs before
   `api` and `worker`; anything pending is applied there. `prisma db push` is
   gone — `npm run db:migrate` in development, `npm run db:deploy` otherwise.

4. **The Prisma schema moved** to `packages/core/prisma/schema.prisma`. Any
   script or alias of your own that names the old path needs adjusting.

5. **n8n is pinned to 2.42.4.** It ran on `latest` before. To keep that, set
   `N8N_IMAGE_TAG=latest` in the `.env`.

6. **Time booked through the automation connector** now carries an hourly rate
   and a client, and completing a task through it closes the lead's follow-up.
   Entries booked before this are **not** corrected retroactively — if a
   workflow has been booking time, those rows have no rate and will be
   invoiced at nothing until they are fixed by hand.

7. **The `.env` still works.** Nothing has to be moved. But as soon as a value
   is set under _Einstellungen_, the database wins and the file stops having
   an effect for that one value.

8. **Re-import both contract workflows** in n8n — _Automatisierungen_ →
   _Vorlagen_, "Vertrag versenden" and "Vertrag signiert". Contracts are a
   table now, not notes with a `[VERTRAG]` title, and the copy running in n8n
   still writes notes: the send would file the contract twice and the signed
   PDF would never reach it. The import needs the updated soloops node, which
   comes with the image.

   Existing `[VERTRAG]` notes are left alone — nothing reads them any more, so
   anything still in flight is filed by hand under the customer, where the
   PDF can be uploaded with it.
