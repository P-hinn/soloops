<h1 align="center">soloops</h1>

<p align="center">
  <strong>A self-hosted operating system for working solo.</strong><br>
  Calendar, meetings, notes, projects, leads, inbox, time tracking, invoices —<br>
  in one place, on your own machine, with MCP access for Claude.
</p>

<p align="center">
  <img alt="MIT License" src="https://img.shields.io/badge/License-MIT-171714?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Node 22" src="https://img.shields.io/badge/Node-22-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3.5-42b883?style=flat-square&logo=vuedotjs&logoColor=white">
  <img alt="Fastify 5" src="https://img.shields.io/badge/Fastify-5-171714?style=flat-square&logo=fastify&logoColor=white">
  <img alt="Prisma 6" src="https://img.shields.io/badge/Prisma-6-2d3748?style=flat-square&logo=prisma&logoColor=white">
  <img alt="PostgreSQL 17" src="https://img.shields.io/badge/PostgreSQL-17-4169e1?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="Docker Compose" src="https://img.shields.io/badge/Docker-Compose-2496ed?style=flat-square&logo=docker&logoColor=white">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-62%20tools-d8ff55?style=flat-square&labelColor=171714">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#modules">Modules</a> ·
  <a href="#two-way-calendar-sync">Calendar sync</a> ·
  <a href="#inbox-and-lead-matching">Inbox</a> ·
  <a href="#mcp-server">MCP</a> ·
  <a href="#deploying-on-a-small-server">Deployment</a>
</p>

---

## Contents

- [What this is](#what-this-is) — scope, assumptions, and what it deliberately isn't
- [Quick start](#quick-start) — from nothing to running in four commands
- [Running as a macOS app](#running-as-a-macos-app) — its own window instead of a browser tab
- [Design system](#design-system) — tokens, rules, classes
- [Tooling and conventions](#tooling-and-conventions) — Prettier, ESLint, the 1000-line limit
- [Architecture](#architecture) — five apps, one monorepo
- [Modules](#modules) — what the thing actually does
- [Two-way calendar sync](#two-way-calendar-sync) — Google, CalDAV, conflict rules
- [Device sync](#device-sync-iphone-and-mac) — iPhone and Mac, no server in between
- [CarPlay](#carplay) — the day in the car, and the entitlement it needs
- [Inbox and lead matching](#inbox-and-lead-matching) — IMAP, rules before AI
- [Activity](#activity-what-the-mac-sees) — samples from the Mac, all local
- [Automations with n8n](#automations-with-n8n) — the editor embedded, with connectors both ways
- [MCP server](#mcp-server) — 74 tools for Claude
- [Authentication](#authentication)
- [Operations](#operations) — logs, schema changes, backup
- [Deploying on a small server](#deploying-on-a-small-server) — 2 cores, 2 GB RAM
- [Security notes for production](#security-notes-for-production)
- [Contributing](#contributing)
- [License](#license)

---

## What this is

soloops is the back office of a one-person software business, built as a single
self-hosted application. It replaces the usual pile of SaaS subscriptions —
calendar, CRM, time tracker, invoicing — with one Docker Compose stack that runs
on a laptop or a small VPS and keeps its data in a database you control.

It is published as-is, because it may be useful to someone with the same
problem. A few things are worth knowing before you invest an evening in it:

- **Single user by design.** There is one owner account and no tenancy
  boundary anywhere. Do not run this for a team; nothing in the data model
  separates one person's records from another's.
- **The interface is German.** Code, comments and this document are English,
  but every label in the UI is German, and so are the AI prompts. Translating
  it is not hard, but nobody has done it.
- **It assumes German invoicing rules** (sequential numbering per year,
  §19 UStG small-business note, lexoffice as the accounting target).
- **No migration history.** Schema changes go out with `prisma db push`. One
  user, one database — see [Operations](#operations).
- **AI is optional.** Everything except digests, lead scores, meeting
  summaries and the quick-entry parser works without an `ANTHROPIC_API_KEY`.

What it is not: a product, a hosted service, or something with a support
promise. See [Contributing](#contributing) for what that means in practice.

---

## Quick start

**Requirements:** Docker with Compose v2. Node 22 only if you want to run the
linter, the tests or the MCP server outside the containers.

**1. Create the configuration**

```bash
cp .env.example .env
```

At minimum, set `POSTGRES_PASSWORD`, `DATABASE_URL` (same password),
`JWT_SECRET`, `SERVICE_TOKEN` and `OWNER_PASSWORD`. Generate secrets with:

```bash
openssl rand -hex 32
```

**2. Bring it up**

```bash
docker compose up -d --build
```

**3. Create the owner account and two example projects**

```bash
docker compose exec api npm -w @soloops/api run seed
```

**4. Log in** at http://localhost:5174 with `OWNER_EMAIL` and `OWNER_PASSWORD`.
The guided tour starts on first login.

| Service  | URL                        |
| -------- | -------------------------- |
| Frontend | http://localhost:5174      |
| API      | http://localhost:3000      |
| n8n      | http://localhost:5174/n8n/ |
| Postgres | localhost:5433             |

n8n is reachable directly on http://localhost:5678 too, but the interface uses
the proxied path — that is what lets the editor sit in an iframe. If you intend
to use the soloops nodes, build them once before bringing the stack up
(`npm run nodes:build`, or `npm run up`, which does it for you).

---

## Running as a macOS app

Instead of living in a browser tab, soloops also runs as a standalone app with
a dock icon, a menu bar and a tray item — a [Tauri](https://tauri.app) window
onto the same interface, around 10 MB, using the macOS WebView rather than
shipping its own Chromium.

```bash
npm run app          # start the app in development mode
npm run app:build    # build soloops.app and a DMG
```

The result lands in
`apps/desktop/src-tauri/target/release/bundle/macos/soloops.app` — drag it to
`/Applications` once and you're done.

**What the app adds on top of the web UI:**

- **Starting the containers itself.** On launch it checks whether web and API
  respond. If they don't, it starts Docker Desktop and runs
  `docker compose up -d`; the splash screen reports what it is waiting for.
  Closing the window leaves the containers running so the worker keeps syncing
  calendars and mail — quit them from the tray menu.
- **Keyboard shortcuts.** ⌘1 to ⌘9 jump to the modules, ⌘R reloads,
  ⌘⇧M fetches the inbox, ⌘⇧P opens the port overview.
- **Port overview** (⌘⇧P or tray). The same thing as `npm run ports`, in a
  window: which service listens on which port, where it comes from, and a
  button to stop it. The app shells out to [`scripts/ports.sh`](scripts/ports.sh)
  for this — the logic exists in exactly one place.
- **Activity recording.** One sample every 20 seconds: which app is in front,
  what its window is called, how long nobody has typed. Off by default — the
  checkbox sits in the tray and under _Ansicht_ and takes effect immediately.
  On first run macOS asks for **Accessibility** permission (System Settings >
  Privacy & Security); without it, nothing is recorded. Details under
  [Activity](#activity-what-the-mac-sees).
- **Follow-up reminders.** A lead whose follow-up falls due becomes a macOS
  notification — once per date, and only between 8 and 22. Details under
  [Follow-ups](#follow-ups).
- **Connecting Claude.** _Einstellungen → Claude_ writes the MCP connector into
  Claude Desktop and Claude Code with one click. Only the app can do this: the
  API runs in a container and has no home directory to write into. Details
  under [MCP server](#connecting).
- **Tray menu.** Show window, fetch inbox, ports, activity on/off, stop
  containers, quit.

Building requires the Rust toolchain ([rustup](https://rustup.rs)) and the
Xcode command line tools. The path to the repository is baked in at build time;
if the directory moves, either rebuild the app or start it with `SOLOOPS_DIR`.

The loaded interface gets as good as **no** access to Tauri APIs (see
[`capabilities/default.json`](apps/desktop/src-tauri/capabilities/default.json)):
it is the same web app as in the browser, just in a different frame. Menu, tray
and container startup run entirely in Rust.

The single exception is the Claude connection
([`capabilities/claude.json`](apps/desktop/src-tauri/capabilities/claude.json)):
there the interface may call exactly three commands — read the status, write the
connector, restart Claude Desktop. The commands are listed in
[`build.rs`](apps/desktop/src-tauri/build.rs), because Tauri treats a page under
`http://localhost` as a remote origin and allows nothing there that no
capability names. Anything beyond those three stays with the menu and Rust.

---

## Design system

The interface borrows its visual language from philippniestroj.com. The tokens
live in one place, [`apps/web/src/style.css`](apps/web/src/style.css), and are
identical to the website's:

| Token                            | Value                 | Role                                 |
| -------------------------------- | --------------------- | ------------------------------------ |
| `--color-paper`                  | `#f1efe8`             | warm off-white, the base surface     |
| `--color-ink`                    | `#171714`             | text, primary button, strong borders |
| `--color-soft` / `--color-muted` | `#575750` / `#6c6b64` | body copy, secondary text            |
| `--color-acid`                   | `#d8ff55`             | lime — the one loud accent           |
| `--color-blue`                   | `#5c76ff`             | kicker labels and links              |
| `--color-line`                   | `rgba(23,23,20,.15)`  | hairline                             |

Three rules carry the look:

1. **Radius 0 everywhere — except buttons.** Surfaces, cards, inputs and badges
   have sharp corners; buttons are always full pills.
2. **Lines instead of boxes.** Tables and grids are structured by hairlines,
   not by raised boxes. Key figures sit under a heavy top rule, without a frame.
3. **Kicker labels.** Sections don't carry an `<h2>` at body size but a small,
   letterspaced uppercase label in blue (`.eyebrow`).

Type: **Space Grotesk** (variable 400–700, self-hosted under
`apps/web/public/fonts/`) for headings, numbers and anything tabular;
Helvetica Neue/Arial for body copy. Digits are tabular throughout so that
amounts and durations line up in columns.

Reusable classes: `.card`, `.btn-primary` / `.btn-ghost` / `.btn-acid` /
`.btn-xs`, `.input`, `.label`, `.badge` (+ `-acid` / `-good` / `-warn` / `-bad` /
`-blue`), `.table`, `.eyebrow`, `.display-xl`, `.prose-note`.

---

## Tooling and conventions

```bash
npm run check      # format, lint, types and tests in one run
npm run format     # Prettier over everything
npm run lint:fix   # ESLint with autofix
npm run test       # RRULE expander, sales logic and activity (60 cases)
npm -w @soloops/desktop run test   # the Rust side of the macOS app (6 cases)
```

The Rust tests are not part of `npm run check`: they need the toolchain, and
only people who build the app need that. The same goes for the Swift ones:

```bash
bash scripts/ios-test.sh              # the sync engine on the phone (104 cases)
npm -w @soloops/api run test:sync     # the op log against a real Postgres
```

`scripts/ios-test.sh` exists rather than a bare `swift test` because building
under `~/Desktop` fails at the code-signing step — files there carry extended
attributes that `codesign` refuses, and `xattr -cr` does not stick. The script
builds outside it.

**Prettier** owns formatting (no semicolons, single quotes, 100 columns),
**tsc** owns types. The **linter** only deals with what neither of them sees —
above all the **1000-line limit per file** (`max-lines`; blank lines and
comments don't count, so good documentation isn't punished). Breaking it means
you have two things in one file. Largest file right now: `CalendarView.vue` at
814 lines.

Comments and commit messages are English; the UI copy is German. Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

### Dependencies held back

Deliberately **not** upgraded, each with a reason:

| Package       | Current | Available      | Why not                                                          |
| ------------- | ------- | -------------- | ---------------------------------------------------------------- |
| TypeScript    | 5.9     | 7.0            | Rewritten compiler, no solid experience with `vue-tsc` yet       |
| Prisma        | 6.19    | 7.10 (8 as RC) | Large migration step; worth its own pass, not a drive-by         |
| Zod           | 3.25    | 4.4            | Changed `.default()`/`.optional()` semantics across every schema |
| `@types/node` | 22      | 26             | Has to match the container runtime, and that is Node 22          |

Known and open: `deepmerge-ts@7.1.5` under `@prisma/config` has a stack
exhaustion on recursive object graphs (GHSA-ggr8-5vv4-36mx, high). The affected
path is the Prisma **CLI** (`generate`, `db push`), not the query engine, and it
only ever processes our own configuration — effectively no attack surface. An
npm `override` to 8.x doesn't take with npm 11; the advisory goes away with the
Prisma upgrade.

---

## Architecture

```
apps/
  api/        Fastify + Prisma + Postgres — REST API, PDF rendering, AI calls
  worker/     BullMQ — calendar and mail sync, uptime, CI/CD, digests, lead
              scores, the n8n mirror and outbound event delivery
  web/        Vue 3 + Vite + Tailwind — the interface
  mcp/        MCP server (stdio) for Claude Code / Claude Desktop
  desktop/    Tauri — the same interface as a macOS app, with menu and tray
  ios/        Swift — the iPhone app and the CarPlay screen, plus the sync engine
packages/
  shared/              Zod schemas and formatters shared by API, web and MCP
  n8n-nodes-soloops/   the soloops nodes, mounted into the n8n container
```

n8n itself is a container rather than an app here — it is run, not written.
What soloops adds around it is the connector package above, a mirror of its
workflows and runs, and the event bridge; see
[Automations](#automations-with-n8n).

Worker and API share the Prisma client and the service layer through relative
imports — one monorepo, one source of truth, no duplicated integrations.

`apps/ios` is the exception: it is a Swift project and not part of the npm
workspace, so it duplicates the one thing it cannot import — the list of
synced fields. A generated fixture and a parity test keep the two copies
honest, see [Device sync](#device-sync-iphone-and-mac).

---

## Modules

**Onboarding.** The first login starts a seven-step tour (spotlight on the
element in question, → or click to advance, Esc to abort). After that the
dashboard keeps a setup checklist that **reads real state**: it only ticks what
actually exists — clients created, time logged, calendars connected,
environment variables set. Deliberately nothing you can tick yourself; a list
like that stops saying anything about the system after two weeks. By default
it is a single line — progress and next step; all steps on click. You can hide
it any time and bring it back under _Settings_.

**Quick entry.** One field on the dashboard: "meeting for a new project with
Example Ltd next week" turns into a _plan_ — client, project, event, video
room, meeting, note, open points. The plan is editable and is only created on
confirmation. Deliberately two-stage: underspecified sentences are the norm,
and creating things silently produces more cleanup than it saves. Next to it,
quick actions for timer, meeting, event, note and invoicing.

The model gets the existing clients and projects plus the real free slots of
the next two weeks as context — so it neither invents clients that already
exist nor proposes times that collide. Whatever it guessed is listed under
"Angenommen" (assumed).

**Calendar.** Week view, events with project references, free-slot
calculation, an ICS feed to subscribe to
(`/api/calendar/feed.ics?token=<SERVICE_TOKEN>`) — and real two-way sync with
Google and Apple, see below.

**Video rooms.** Every meeting and every event can get a room via checkbox.
The default is **Jitsi**: no account, no setup, and the room name carries 8
random characters (with Jitsi the name is the only secret). With a connected
Google account you can create **Google Meet** links instead; a permanent room
of your own (Zoom, Teams) works through `VIDEO_CUSTOM_URL` or per meeting as a
custom link. The room ends up in the meeting, the calendar entry, the ICS feed
and both remote calendars.

**Meetings.** Create a meeting (optionally creating the calendar entry with
it), type up notes, then optionally an AI summary with decisions and action
items.

**Sales.** Leads in four open stages (new, qualified, offer, negotiation) plus
won and lost. Every lead records **what you offered for what**: title, amount,
scope, sent on, valid until. Once an offer is out, its amount counts as the
value of the lead — a number on paper is more reliable than a guess from the
first call. Sending an offer advances the stage on its own.

The forecast is amount times **your** probability. Next to it sits an AI score
from 0 to 100 with a rationale and a next step, refreshed at 6:30 on weekdays.
It never overwrites your own estimate — when the two differ by more than 15
points the UI shows the gap, because that is exactly where thinking pays off.
Anything untouched for more than two weeks gets flagged.

**Notes.** Markdown, tags, project references, German Postgres full-text search
(GIN index over title + body, created at API startup).

**Project digests with AI.** One status report per project: traffic light,
next steps with urgency, risks, a billing hint. Produced through structured
outputs (`claude-opus-5`, adaptive thinking) so the UI renders a fixed schema
instead of parsing free text. The worker rebuilds every report at 7:30 on
weekdays.

**Uptime.** Mirrors UptimeRobot monitors including down logs every 5 minutes;
monitors can be assigned to projects and then show up in the project view.

**CI/CD.** GitHub Actions and GitLab pipelines, polled every 3 minutes, also
per project.

**Time tracking.** A stopwatch at the top of _Zeiten_: project (the one you
booked last is preselected), description, start. While it runs you can fill in
the description; "discard" stops and deletes in one go so no two-second entry
ends up in the report. "Continue with" picks up recent combinations by click.
The running timer is visible in the sidebar and the header; starting one on a
project stops a running one automatically. Plus manual entries and
weekly/monthly reports with the value in euro. Hourly rate resolves project >
client > global default.

There is deliberately no password manager — that is what 1Password is for.
soloops only stores the credentials it needs for its own syncing (calendar
tokens, encrypted at rest).

**Activity.** The day band at the bottom of _Zeiten_: what ran on the Mac, as
stripes over an hour axis, with the segments spelled out underneath. Mapping to
projects is the next stage — for now this is the raw material. See
[Activity](#activity-what-the-mac-sees).

**Invoices.** "Create from time" takes all open, billable entries of a client
in the period, groups them per project and links the time entries firmly to the
line item — so nothing lands on two invoices. The PDF is rendered server-side
with pdfkit (close to DIN 5008, with the §19 UStG note if configured).
Sequential numbering per year. Issued invoices are locked and can only be
cancelled.

**Accounting.** A lexoffice adapter: create contacts, transfer invoices as
finalized documents (`finalize=true`), monthly revenue net/VAT/gross for the
advance VAT return.

**Automations.** A full n8n under _Automatisierungen_ — its drag-and-drop
canvas embedded in soloops, soloops nodes in its palette, templates to start
from, and the run and delivery logs that say whether any of it is still
working. See [Automations](#automations-with-n8n).

---

## Two-way calendar sync

Set up under _Settings_. After that the sync runs automatically
(`CALENDAR_SYNC_CRON`, every 10 minutes by default) and can be set to _read
only_ or _write only_ per account.

**Google Calendar** — OAuth with the `calendar` scope, nothing more. The sync
runs incrementally on Google's `syncToken`; if that expires, one full read
happens automatically. `singleEvents=true` expands series into individual
events, which makes recurring events fully editable.

Preparation: in the Google Cloud Console enable the Calendar API, create an
OAuth client ID (web application) and register exactly
`http://localhost:3000/api/calendar-accounts/google/callback` as the redirect
URI.

**Apple / iCloud** — over CalDAV, with an _app-specific password_
(appleid.apple.com → Sign-In and Security). The regular Apple password does not
work. Changes arrive through WebDAV sync (RFC 6578); if a server doesn't
support it, soloops falls back to comparing ETags and says so in the calendar
list.

The same code works against Nextcloud, Fastmail or Radicale — just point
`CALDAV_APPLE_URL` wherever you like.

### How conflicts are decided

Every link remembers two states: what was last written out, and what was last
pulled in. That lets the sync recognise an event it pushed itself and not write
it again — otherwise the two systems would ping-pong forever.

If **both sides** changed since the last run, the newer timestamp wins. Nothing
is merged field by field, and the decision ends up in the log and in the sync
message. Deletions leave a tombstone so they still propagate once the local
event is already gone.

### What gets written, and what doesn't

Exactly one account carries the **target calendar** flag. Only events created
in soloops go there. An event that came from calendar A is never copied to
calendar B — otherwise every entry would multiply across all connected
calendars.

**Remote deletion only happens with explicit per-account consent**, off by
default. A misclick in soloops should not remove events from all your devices.

### Two deliberate limits

- **CalDAV series are read-only.** They appear as a single event, are marked
  read-only and are never written back. Handling recurrence rules correctly in
  both directions (exceptions, moved instances, timezone changes) is a project
  of its own. With Google the question doesn't arise, because instances are
  what gets synced.
- **Without WebDAV sync, the CalDAV fallback cannot detect deletions.** An
  event deleted on the Apple side would stay put locally. Rather than guessing
  (and losing events outside the sync window in the process), soloops keeps it
  and shows a warning when the account is connected.

---

## Device sync (iPhone and Mac)

The iPhone and the Mac keep each other up to date directly. There is no server
in between and no account anywhere — the data lives on those two devices, which
is the whole point and also the thing that makes it harder than it sounds.

Set up under _Settings → iPhone_: the Mac shows an eight-character code, the
phone redeems it over the local network, and from then on the phone holds a
long random token. The code is single-use and valid for ten minutes.

### An operation log, not a table diff

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

### Which is newer, when both clocks are wrong

Comparing `updatedAt` does not work. A Mac waking from sleep can briefly report
a time behind the phone's, and the newer edit would then lose silently. So
every op carries a **hybrid logical clock**: the wall clock as the coarse part,
never allowed to go backwards, with a counter for ties, and reading a remote
stamp pulls the local clock past it. Stamps are fixed-width strings, so sorting
them as text sorts them in time — Postgres, SQLite and Swift all agree on the
order without any of them parsing anything.

### Last writer wins, per field

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

### Two routes, different failure modes

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

### What syncs

Clients, projects, calendar events, leads, time entries, meetings, action items
and notes. `Project` is in there because `TimeEntry.projectId` is non-null — a
phone that cannot see projects cannot log time against one.

Host-local columns deliberately stay put: `lastPushedAt` belongs to this
machine's CalDAV sync, `followUpNotifiedAt` to its notifications,
`lexofficeContactId` to its accounting link. Invoices do not sync at all.

### Keeping the two field lists in step

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

---

## CarPlay

soloops has its own icon on the CarPlay home screen: a spoken briefing of the
day, today's appointments, and the follow-ups that are due — all read from the
phone's local database, because a car usually has no useful network.

### The entitlement

**A CarPlay app needs an entitlement that Apple grants per app**, and that is
not a formality: without it the CarPlay scene is never created, on a real head
unit or in Xcode's CarPlay simulator. There is no way around it.

This app is built against `com.apple.developer.carplay-audio`, declared in
`Soloops.entitlements` and named in `CarPlayConfiguration`. That category is
the one with a realistic chance of being granted, and it fits: the content
really is audio, and the lists are how you choose which part of it to hear. For
a driver that is the right way round anyway — a list you read at 80 km/h is a
list you should not have been reading.

Request it at <https://developer.apple.com/contact/carplay/>. Until it comes
through, everything except the CarPlay screen works: the phone app, and Siri,
which runs in the car without any entitlement at all.

`com.apple.developer.carplay-driving-task` would describe an agenda more
literally and is granted far more narrowly, mostly to vehicle manufacturers. If
you ever get it, change the key in the entitlements file — the templates used
here are permitted in both categories.

### What it does in the car

- **Tag vorlesen** — appointments still to come and the due follow-ups, spoken,
  with the count first so the length is known in advance. Speech ducks the
  radio rather than interrupting it, and the steering-wheel controls work
  through `MPNowPlayingInfoCenter`.
- **Heute** — the day's appointments. Tapping one with an address hands it to
  whatever app is doing navigation; one without gets read aloud.
- **Wiedervorlage** — the due follow-ups, each with three one-tap choices:
  call, postpone to tomorrow, done. Anything more belongs on the phone.

### Travel time, recorded by itself

CarPlay connecting and disconnecting is a reliable signal that a journey
started and ended, and travel to a customer is work that usually goes unbilled
because nobody starts a stopwatch while parking.

The destination is inferred from the calendar: a drive ending shortly before an
appointment, or starting shortly after one, was almost certainly to or from it,
and the entry is booked against that project as "Anfahrt" or "Rückfahrt". When
nothing lines up, **the drive waits on the _Fahrten_ screen instead of being
booked against a guess** — time landing on the wrong customer is worse than
time not landing at all, because nobody goes looking for an entry they did not
expect. Drives under three minutes and over four hours are discarded; the
latter is a phone left in a parked car with the ignition on.

### Siri

Works in CarPlay with no entitlement, and is the fastest way to any of this
with both hands on the wheel: _Nächster Termin_, _Tagesbriefing_, _Fällige
Wiedervorlagen_, _Notiz an soloops_, _Zeit starten_. All of them read and write
the local database only — a phrase that needed the network would fail exactly
where it is wanted most.

### Building it

The Xcode project is generated, not committed:

```bash
brew install xcodegen
cd apps/ios && xcodegen
open Soloops.xcodeproj
```

Everything that decides how the app behaves — the scene manifest, the
entitlements, the asset catalog with its CarPlay icon slot — is in version
control next to `project.yml`. Installing on a real iPhone needs an Apple
Developer account; free signing expires after seven days.

---

## Inbox and lead matching

soloops reads an existing mailbox over IMAP and matches mail to leads, clients
and projects. Set it up under _Settings_ with server, user and password; the
host is guessed from the address (Strato, mailbox.org, Posteo, IONOS, All-Inkl
and Gmail are known). The password is encrypted at rest, like the calendar
credentials.

**Read-only, strictly.** There is no delete, no move and no flag setting in the
code — not even "mark as read". Your mail client cannot tell that something is
reading along, and a bug in soloops cannot damage the mailbox. Headers and
bodies are stored, attachments are not.

### Rules before AI

Matching runs in three stages, cheapest first:

1. **Sender address** is a contact on a lead → certain match.
2. **Sender domain** belongs to a known client → match to the client. Freemail
   domains don't count here, otherwise every GMX address lands on the first
   client who happens to use GMX.
3. Only when nothing catches does the AI decide.

In practice stage 1 hits almost every time — ongoing correspondence comes from
addresses that are already in the system. Which means the normal case costs no
API call at all.

The model only ever sees short summaries of the known leads, clients and
projects, and **must point at one of the supplied identifiers**; anything else
is discarded on read. A manual assignment is marked `MANUAL` and is never
overwritten automatically later.

### Two deliberate limits

- **A mail never becomes a lead automatically.** That is a button in the inbox.
  Otherwise the first marketing mail containing the word "offer" creates one.
- **Mail content is never rendered as Markdown.** Neither the text itself nor
  what the AI derives from it — both go out as plain text. Otherwise a crafted
  mail would be a way to get script into your own interface.
  `MarkdownBlock.vue` stays reserved for your own content.

### Follow-ups

A lead carries one date and one reason: _come back to this on the 8th, the
offer needs chasing_. Set it on the lead, move it with one click (+1 day, +3
days, +1 week), and tick it off when the call has happened.

Three places show it: the lead itself, the leads view (due ones above the
pipeline, a `WV` marker on the card) and the dashboard. On top of that the
macOS app turns a due follow-up into a notification — once per date, between 8
and 22, and never again until the date moves. The marking lives on the server
(`followUpNotifiedAt`), so quitting the app does not turn a reminder into a
nag.

Two decisions worth knowing:

- **Putting a lead on follow-up is not contact with the customer.** It leaves
  `lastActivityAt` alone, so "gone quiet for 20 days" keeps counting while a
  reminder sits in the future. Only ticking it off counts as contact — that is
  when the history entry is written.
- **Closed leads keep their follow-ups.** "Ask again in six months" is a
  perfectly good reason to put a lost deal on the list, so WON and LOST are
  not filtered out.

---

## Activity: what the Mac sees

A stopwatch assumes you remember to press it when you switch tasks. The day
band takes the other route: the macOS app measures what was worked on, and that
should eventually become time entries you only have to confirm.

**Stage 1 — measured and visible.** What exists today: recording, storage and
display. Mapping to projects follows.

### What gets measured

One sample every `ACTIVITY_SAMPLE_SECONDS` (20 by default), with four fields:

| Field        | Source                                 | Permission    |
| ------------ | -------------------------------------- | ------------- |
| Bundle ID    | `osascript` → System Events            | Accessibility |
| App name     | same                                   | Accessibility |
| Window title | `AXTitle` of the frontmost window      | Accessibility |
| Idle time    | `ioreg -c IOHIDSystem` → `HIDIdleTime` | none          |

No keystrokes, no screen contents, no network connections. The window title is
where this gets interesting later: it holds the file name, the repository, the
subject line or the ticket number — enough to attribute an activity to a
project without reading along anywhere.

### Why no AI

To classify this, a model would mostly need world knowledge — and that is
already in the database here: `Project.key`, `PipelineRepo.slug`,
`Client.company`, `Lead.contactEmail`, today's calendar entries. A title like
`philippniestroj/soloops · Pull Request` hits the project key directly. So the
plan is three local layers instead of an API call:

1. **Matching against your own database** — covers project work to a large
   degree, and works for a new project from the second it is created.
2. **Your own rules** — bundle ID plus title patterns for everything without a
   database reference (sales, bookkeeping, learning).
3. **A learning classifier** — naive Bayes over the words from title and bundle
   ID, trained exclusively on your own confirmed bookings.

That way no window title ever leaves this machine.

### Privacy

- **Off by default.** `ACTIVITY_TRACKING=false`; the tray checkbox switches at
  runtime and takes effect on the next tick.
- **Blocklist.** Apps listed in `ACTIVITY_PRIVATE_APPS` (password managers,
  banking, messengers) are stored without a title. The time range stays
  visible, the content does not.
- **Forgetful.** The worker deletes anything older than
  `ACTIVITY_RETENTION_DAYS` (30 by default) overnight. Individual segments can
  be removed from the day band immediately with ✕.
- **Local only.** The app posts samples to `127.0.0.1` and nowhere else.

### When the API isn't running

The app buffers line by line into `data/activity-pending.jsonl` and sends once
a minute. If the containers are down or the app is quit, the buffer is still
there on the next start; only after roughly four days of backlog does the
oldest fall off. Sending happens over a raw HTTP request — the whole feature
adds no Rust dependency at all.

---

## Automations with n8n

_Automatisierungen_ in the sidebar is a full n8n, running as its own container
and served under `/n8n/` through the soloops origin. The drag-and-drop canvas
in the **Builder** tab is the real n8n editor in an iframe — not a rebuild of
one. That only works because it is same-origin; a separately hosted n8n would
be blocked by `X-Frame-Options`, which is why the proxy exists in both
`vite.config.ts` and `deploy/nginx.conf`.

```
soloops                                n8n
  Automatisierungen
    Builder     ──iframe /n8n/────────▶ editor (same origin)
    Flows       ◀──mirror, 2 min──────  workflows + executions
    Vorlagen    ──POST /api/v1/────────▶ a finished workflow
    Verbindungen
      ├─ n8n API key ─────────────────▶ lets soloops read the two above
      ├─ automation token ◀────────────  lets the Soloops nodes write back
      └─ triggers ◀───registered by────  the Soloops Trigger node itself
                   soloops ──events──▶  webhook
```

### Setup

1. `npm run up` brings n8n along. First visit asks for an owner account —
   that is n8n's own, unrelated to the soloops login.
2. In n8n: **Settings → n8n API → Create an API key**. Paste it into
   _Automatisierungen → Verbindungen_. It cannot be set from the outside, so
   this step cannot be skipped; soloops checks the key against n8n before
   storing it (encrypted, see `services/secretbox.ts`).
   Without it the Builder still works — flows, templates and monitoring stay
   empty.
3. Still under _Verbindungen_: create an **automation token**. It is shown
   once. In n8n under **Credentials → soloops API**, paste it with base URL
   `http://api:3000`.

The token is deliberately not the `SERVICE_TOKEN`: that one also opens the
macOS app and the MCP server and cannot be revoked without taking both down.
An automation token is revocable on its own, can be read-only, and reaches
**only** `/api/automations/connector` — see [Authentication](#authentication).

### The connector

`packages/n8n-nodes-soloops` is mounted into the container read-only via
`N8N_CUSTOM_EXTENSIONS` and adds two nodes plus a credential:

| Node                | What it does                                                                         |
| ------------------- | ------------------------------------------------------------------------------------ |
| **Soloops**         | Leads (create, read, update, move stage, log activity), projects, tasks, time, notes |
| **Soloops Trigger** | Starts a workflow on a soloops event                                                 |

`dist/` is gitignored, so the package is built before the container reads it —
`npm run up` does that, or `npm run nodes:build` on its own. After a connector
change, rebuild and restart just that container.

**The trigger registers itself.** Switching the workflow on in n8n is the whole
of the setup: n8n calls `POST /api/automations/connector/triggers` with its own
webhook URL, and soloops starts posting there. Switching it off removes the
registration. Nothing to copy between tabs — and the consequence worth knowing
is that a workflow which is merely _saved_ receives nothing.

### Events

Every delivery is one POST with a stable envelope, so an expression typed into
a graph eight months ago still resolves:

```json
{
  "event": "lead.won",
  "at": "2026-10-07T09:30:00.000Z",
  "projectId": "clx…",
  "url": "http://localhost:5174/leads/clx…",
  "data": {
    "id": "clx…",
    "title": "…",
    "stage": "WON",
    "previousStage": "NEGOTIATION"
  }
}
```

In the workflow that is `{{ $json.data.id }}`.

| Event                | Fires when                                                     |
| -------------------- | -------------------------------------------------------------- |
| `lead.created`       | a lead is created — by hand, by MCP, or out of the inbox       |
| `lead.stage_changed` | the stage actually moves (saving the same stage fires nothing) |
| `lead.won`           | …and it moved to won                                           |
| `lead.lost`          | …and it moved to lost                                          |
| `project.created`    | a project is created                                           |
| `meeting.ended`      | a meeting crosses into `DONE`                                  |
| `task.completed`     | an open action item is ticked                                  |
| `note.created`       | a note is created                                              |

They are emitted from the service layer, not from one route, so a lead moved
through the interface, through Claude and through a workflow all produce the
same events. A trigger with no project set takes everything of its kind; one
scoped to a project takes only that project's events — and deliberately not
events belonging to no project at all.

A delivery carries `X-Soloops-Signature`, an HMAC-SHA256 of the exact body
under a secret handed over at registration, so the receiving end can tell a
real call from a replayed one.

### Monitoring

The **Flows** tab is the monitoring. Per flow: a strip of the last twelve runs
(newest right), the last outcome, and — when it is failing — the actual error
message from n8n rather than the fact that there was one. Failing flows sort to
the top and the tab carries a dot.

The mirror is pulled every two minutes (`AUTOMATION_POLL_CRON`), with the
newest `AUTOMATION_RUN_HISTORY` runs kept per flow; the full history stays in
n8n, where it is one click away. A workflow deleted in n8n is marked rather
than dropped, so its run history and project assignment survive.

The other direction has its own log, under _Verbindungen_: every attempt to
post an event, with status and error. Without it an automation that quietly
stopped firing looks exactly like one that was never set up. A failed delivery
is retried after 30 s, 2 min and 10 min — but only when a repeat could change
anything: a network error or a 5xx/408/429, never a 404. After ten failures in
a row a trigger switches itself off instead of calling a dead endpoint forever.

### Templates

Six ready-made workflows under _Vorlagen_, built on the soloops nodes — won
lead becomes a project, new lead into a chat, stage changes logged on the lead,
follow-up after a meeting, a lost lead resurfacing in six months, a morning
pipeline digest. One click creates one in n8n.

They land **inactive** on purpose: a template cannot know which credential to
use — n8n credentials live in n8n — so the honest end of an import is "here it
is, open it".

---

## MCP server

Gives Claude the full dataset — reading and writing. Day overview, search,
what ran on the Mac, clients, projects, calendar, meetings, to-dos, notes,
timer and manual time entries, leads with offers, follow-ups and AI score,
inbox, operational status, unbilled time, invoice drafts, revenue,
automations.

### Connecting

**Settings → Claude → „Mit Claude verbinden"**, inside the macOS app. One click
writes the connector into Claude Desktop's config (a copy of the old file stays
next to it) and registers it with Claude Code for every project. Afterwards
Claude Desktop has to restart — it reads that file only at startup, and the
card offers the button for it.

What gets written are absolute paths to node, to tsx and to the server. Claude
starts the connector itself and inherits none of the PATH a terminal has, which
is where `npx`-based entries usually fail.

Doing it by hand works too. Inside this repository nothing has to be
registered: `.mcp.json` is part of it, and the server reads the `SERVICE_TOKEN`
out of `.env` by itself. For a Claude on another machine:

```bash
SOLOOPS_URL=http://localhost:3000 \
SOLOOPS_TOKEN=<SERVICE_TOKEN> \
claude mcp add soloops -- npx tsx /path/to/soloops/apps/mcp/src/index.ts
```

The card shows when Claude was last here — the proof that the connector works
rather than merely exists. The desktop app uses the same token for its activity
samples, so both name themselves in an `X-Soloops-Client` header and are
counted apart.

### Tools

| Area        | Tools                                                                                                                                                                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview    | `soloops_today`, `soloops_search`, `soloops_activity_day`, `soloops_ops_status`                                                                                                                                                                                                                                                                                                     |
| Clients     | `soloops_list_clients`, `soloops_get_client`, `soloops_create_client`, `soloops_update_client`                                                                                                                                                                                                                                                                                      |
| Projects    | `soloops_list_projects`, `soloops_get_project`, `soloops_create_project`, `soloops_update_project`, `soloops_project_digest`                                                                                                                                                                                                                                                        |
| Calendar    | `soloops_free_slots`, `soloops_list_events`, `soloops_create_event`, `soloops_update_event`, `soloops_delete_event`                                                                                                                                                                                                                                                                 |
| Meetings    | `soloops_list_meetings`, `soloops_get_meeting`, `soloops_create_meeting`, `soloops_update_meeting`, `soloops_summarize_meeting`                                                                                                                                                                                                                                                     |
| To-dos      | `soloops_list_tasks`, `soloops_create_task`, `soloops_update_task`, `soloops_complete_task`, `soloops_delete_task`                                                                                                                                                                                                                                                                  |
| Notes       | `soloops_list_notes`, `soloops_get_note`, `soloops_create_note`, `soloops_update_note`                                                                                                                                                                                                                                                                                              |
| Time        | `soloops_timer_status`, `soloops_timer_start`, `soloops_timer_stop`, `soloops_log_time`, `soloops_update_time`, `soloops_delete_time`, `soloops_time_report`                                                                                                                                                                                                                        |
| Money       | `soloops_unbilled_time`, `soloops_list_invoices`, `soloops_draft_invoice_from_time`, `soloops_set_invoice_status`, `soloops_revenue`                                                                                                                                                                                                                                                |
| Sales       | `soloops_pipeline`, `soloops_list_leads`, `soloops_get_lead`, `soloops_create_lead`, `soloops_update_lead`, `soloops_set_lead_stage`, `soloops_archive_lead`, `soloops_log_lead_activity`, `soloops_log_offer`, `soloops_update_offer`, `soloops_score_lead`                                                                                                                        |
| Inbox       | `soloops_inbox`, `soloops_assign_mail`, `soloops_lead_from_mail`                                                                                                                                                                                                                                                                                                                    |
| Automations | `soloops_automations`, `soloops_automation_status`, `soloops_automation_runs`, `soloops_automation_sync`, `soloops_automation_set_active`, `soloops_automation_assign_project`, `soloops_automation_templates`, `soloops_automation_import_template`, `soloops_automation_triggers`, `soloops_automation_deliveries`, `soloops_automation_set_trigger`, `soloops_automation_delete` |

The writing tools stay conservative where money or other people are involved:
`soloops_draft_invoice_from_time` only produces a draft — sending it and
transferring it to lexoffice stay manual. Leads and projects are archived
rather than deleted, time entries that are already invoiced refuse to go, and
entries from connected calendars are read-only here.

The automation tools read, switch and import, but never edit a graph. A second
way to author workflows would have to agree with the editor forever, and the
editor is both one click away and better at it. What Claude is genuinely useful
for here is "what stopped working and why" — which is what the run and delivery
logs answer.

---

## Authentication

Three ways into the API:

- **JWT** for the interface (`POST /api/auth/login`, valid for 30 days)
- **`SERVICE_TOKEN`** as a bearer token for the worker, the MCP server and the
  ICS feed
- **Automation tokens** (`slp_…`) for n8n workflows, created per connection
  under _Automatisierungen → Verbindungen_

Passwords are hashed with scrypt (no native module required). Automation
tokens are stored as a SHA-256 hash and shown exactly once — 192 random bits
have nothing to brute-force, and a deliberately slow hash would be a
self-inflicted rate limit on every call a workflow makes.

The automation tokens are scoped by surface, not only by right. One does
**not** pass the ordinary gate: it opens `/api/automations/connector` and
nothing else — not the mailbox, not the invoices, not every route that happens
to exist. Widening that is a deliberate edit to one route file rather than a
side effect of minting a token. Within the connector, anything that is not a
`GET` needs the `write` scope.

---

## Operations

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

### Configuration

Every environment variable is documented in
[`.env.example`](.env.example); [`apps/api/src/env.ts`](apps/api/src/env.ts) is
the authoritative source with types and defaults. If something required is
missing, the API refuses to start and says what.

### Backup

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

### Troubleshooting

| Symptom                                | Cause and fix                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| API won't start, log names a variable  | A required field in `.env` is missing or too short (`JWT_SECRET` needs 16+ chars)    |
| Login fails although `.env` is correct | The seed never ran: `docker compose exec api npm -w @soloops/api run seed`           |
| Events missing from the week view      | Account just connected? The first sync only fetches the window — check `worker`      |
| CalDAV reports an authentication error | Apple needs an app-specific password, not the Apple ID password                      |
| Web loads, API answers 502             | The API container is still starting (`prisma db push`); `docker compose logs -f api` |
| Day band stays empty                   | Activity recording is off, or macOS has not been granted Accessibility               |

---

## Deploying on a small server

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

### Memory

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

---

## Security notes for production

- Do not map `postgres` and `redis` to the outside — neither has
  authentication of its own. The
  [production compose](#deploying-on-a-small-server) already doesn't; only the
  development compose exposes Postgres on 5433.
- Put it behind a reverse proxy with TLS; `SERVICE_TOKEN` appears in the ICS
  feed as a query parameter and has no business travelling over plain HTTP.
- `.env` is in `.gitignore` and should stay there.
- PDFs sit unencrypted in the `./data` volume — treat backups accordingly.
- Mail bodies sit in Postgres in plain text. If you don't want that, don't
  connect a mailbox; there is no half-way version.
- The IMAP password is encrypted with `JWT_SECRET`. Rotate that key and the
  account has to be reconnected — by design. The same holds for the n8n API
  key and the trigger secrets.
- **n8n runs arbitrary code.** A workflow can execute JavaScript and reach
  anything on the Docker network, so `/n8n/` deserves the same protection as
  the rest of the application and n8n's own owner account deserves a real
  password. The production compose gives it no port of its own; it is only
  reachable through nginx.
- Revoke an automation token when the workflow using it is gone. It is scoped
  to the connector surface, but that surface still writes leads, projects,
  tasks, time and notes.
- Event payloads land in the delivery log, including the lead data they
  carried. That log lives in Postgres like everything else — the same backup
  and the same caveats apply.

Found a vulnerability? Please report it privately through GitHub's security
advisories rather than opening a public issue.

---

## Contributing

This is a personal tool that happens to be public. It is maintained for exactly
one user's workflow, and that shapes what can be accepted:

- **Bug reports are welcome**, especially with the log output and the steps to
  reproduce.
- **Pull requests are welcome** for bugs, documentation and portability. For
  features, open an issue first — the answer may well be "that's out of scope",
  and it's better to hear that before writing the code.
- **Feature requests that add a second user, a tenancy model or a hosted mode
  will be declined.** That is a different product.
- Fork it. The license allows it, the stack is ordinary, and a fork that goes
  its own way is a better outcome than a compromise nobody wanted.

Before opening a pull request, run `npm run check` (and
`npm -w @soloops/desktop run test` if you touched the macOS app). Keep the
existing conventions: German UI copy, English code and comments, Conventional
Commits.

---

## License

[MIT](LICENSE) — Philipp Niestroj.
