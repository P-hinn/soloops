# Device sync (iPhone and Mac)

The iPhone and the Mac keep each other up to date directly. There is no server
in between and no account anywhere — the data lives on those two devices, which
is the whole point and also the thing that makes it harder than it sounds.

Set up under _Settings → iPhone_: the Mac shows an eight-character code, the
phone redeems it over the local network, and from then on the phone holds a
long random token. The code is single-use and valid for ten minutes.

## An operation log, not a table diff

Every change to a synced row appends an **op**: which row, which fields, and a
timestamp. The phone keeps the same log in SQLite. Syncing is then just
"everything since my cursor", in both directions.

The log is written by a Prisma client extension (`services/syncHook.ts`), not
by the routes. There are around thirty write sites across the API, the worker
and the MCP server, and a sync that relies on all of them remembering to log is
a sync that is already broken. Three things that extension has to get right,
each of which is otherwise a silent data-loss bug:

- **Narrow patches.** An op claims only the fields the write touched, and the
  values always come from the row Prisma returns — so `{ increment: 1 }` and
  `{ set: [...] }` record what actually landed.
- **Bulk writes.** `updateMany` and `deleteMany` report a count, not rows, so
  the ids are resolved before the write runs. `createMany` is refused outright,
  because its generated ids are not recoverable afterwards.
- **Cascades.** `onDelete: Cascade` and `SetNull` happen inside Postgres and
  Prisma never mentions them. They are declared in `services/syncEntities.ts`
  and expanded before the parent row disappears.

## Which is newer, when both clocks are wrong

Comparing `updatedAt` does not work. A Mac waking from sleep can briefly report
a time behind the phone's, and the newer edit would then lose silently. So
every op carries a **hybrid logical clock**: the wall clock as the coarse part,
never allowed to go backwards, with a counter for ties, and reading a remote
stamp pulls the local clock past it. Stamps are fixed-width strings, so sorting
them as text sorts them in time — Postgres, SQLite and Swift all agree on the
order without any of them parsing anything.

## Last writer wins, per field

Per row would be cheaper and wrong in exactly the case this exists for: you
tick off an action item in the car while the Mac writes an AI summary onto the
same meeting. Both edits are real, they touch different columns, and a
row-level comparison throws one away.

Per-field LWW normally means a timestamp per column — eighty-odd extra columns.
It is not needed, because the op log already _is_ that record: "who last wrote
`done` on this item" is a query over the ops for that row. The log does double
duty and the nine synced models keep their shape.

One rule in there is a judgement call rather than a consequence: **an edit made
after a delete keeps the row alive.** The edit is work, the delete is the
absence of it. Keeping the row loses nothing a second delete cannot fix;
honouring the delete would throw away something nobody can get back.

## Catching something on the phone

The phone's first tab is one text field and three buttons: lead, task, note.
First line becomes the title, the rest the body, and German date words —
_morgen_, _Freitag_, _in 3 Tagen_ — become a due date, shown under the field
before saving rather than as a surprise in the list afterwards.

Deliberately not the Mac's AI quick entry. That one reads a sentence, proposes
a client, a project and three appointments, and waits for confirmation — right
at a desk, wrong in a car park, where it needs network, reading and a decision.
The rule here is blunt enough to predict, so what you get is what you typed.

It writes to the local database, not to the API, so it works with no network
at all and travels on the next sync. `Capture` in SoloopsKit holds the rules
and is tested against the entity registry: every draft fills the required
fields of the table it targets, and writes no column that does not exist —
a row the Mac rejects would sync, fail the merge and vanish without a word.

## Two routes, different failure modes

- **Local network.** The phone talks to the API directly. Immediate, settles
  ops in the same request, and the only route that can hand over a snapshot.
  Gone the moment the phone leaves the house.
- **iCloud Drive.** The phone writes op batches as files into its own iCloud
  container; the macOS app watches that folder and hands them to the local API
  (`apps/desktop/src-tauri/src/sync.rs`). Works from anywhere, takes seconds to
  minutes, and has **no delivery receipt** — so a batch may arrive twice, and
  ops sent this way stay pending until they come back as shared history. That
  is the only acknowledgement this route can give; treating the file write as
  confirmation is how an offline-first sync loses a day of work.

Neither is a fallback for the other. The LAN is used when it is there because
it is immediate; iCloud otherwise because it is the only thing left.

## What syncs

Clients and the people at them, projects, calendar events, leads, time entries,
meetings, action items (including which lead's follow-up one belongs to) and
notes. `Project` is in there because `TimeEntry.projectId` is non-null — a
phone that cannot see projects cannot log time against one.

Host-local columns deliberately stay put: `lastPushedAt` belongs to this
machine's CalDAV sync, `followUpNotifiedAt` to its notifications,
`lexofficeContactId` to its accounting link. Invoices do not sync at all, and
neither do the commits and pull requests on a task: reading a diff is not
something that happens in the car, and every synced field is one the Swift
registry has to mirror forever.

## Keeping the two field lists in step

The phone builds its SQLite schema before it has ever paired, so it cannot ask
the Mac what the columns are — `SyncEntities.swift` is a hand-kept copy of
`syncEntities.ts`. Copies drift, and this one would drift **silently**: a field
the Mac syncs and the phone does not know is simply dropped on arrival, with no
error anywhere.

So the API writes its registry to a fixture and the Swift tests hold their copy
against it:

```bash
npm -w @soloops/api run sync:registry   # after changing SYNC_ENTITIES
bash scripts/ios-test.sh                # fails if the two no longer agree
```
