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
  --schema apps/api/prisma/schema.prisma
```

Without this, `migrate deploy` tries to create tables that exist and stops.
Afterwards `docker compose up` works as usual. Take a backup first — the
backup window of the macOS app does it in one click, see
[macOS app](macos-app.md).

## Configuration

Every environment variable is documented in
[`.env.example`](../.env.example); [`apps/api/src/env.ts`](../apps/api/src/env.ts) is
the authoritative source with types and defaults. If something required is
missing, the API refuses to start and says what.

## Backup

Two things have to come along: the database and `./data` (invoice PDFs). The
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
