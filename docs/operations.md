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

Schema changes: edit `prisma/schema.prisma`, then `docker compose restart api` —
the container runs `prisma db push` on startup. There is deliberately no
migrations folder: one user, one database, `db push` is enough. If you change
that, take a backup first — `db push` can drop columns.

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

| Symptom                                | Cause and fix                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| API won't start, log names a variable  | A required field in `.env` is missing or too short (`JWT_SECRET` needs 16+ chars)    |
| Login fails although `.env` is correct | The seed never ran: `docker compose exec api npm -w @soloops/api run seed`           |
| Events missing from the week view      | Account just connected? The first sync only fetches the window — check `worker`      |
| CalDAV reports an authentication error | Apple needs an app-specific password, not the Apple ID password                      |
| Web loads, API answers 502             | The API container is still starting (`prisma db push`); `docker compose logs -f api` |
| Day band stays empty                   | Activity recording is off, or macOS has not been granted Accessibility               |
