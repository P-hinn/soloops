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
  <img alt="MCP" src="https://img.shields.io/badge/MCP-31%20tools-d8ff55?style=flat-square&labelColor=171714">
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
- [Inbox and lead matching](#inbox-and-lead-matching) — IMAP, rules before AI
- [Activity](#activity-what-the-mac-sees) — samples from the Mac, all local
- [MCP server](#mcp-server) — 31 tools for Claude
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

| Service  | URL                   |
| -------- | --------------------- |
| Frontend | http://localhost:5174 |
| API      | http://localhost:3000 |
| Postgres | localhost:5433        |

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
- **Tray menu.** Show window, fetch inbox, ports, activity on/off, stop
  containers, quit.

Building requires the Rust toolchain ([rustup](https://rustup.rs)) and the
Xcode command line tools. The path to the repository is baked in at build time;
if the directory moves, either rebuild the app or start it with `SOLOOPS_DIR`.

The loaded interface deliberately gets **no** access to Tauri APIs (see
[`capabilities/default.json`](apps/desktop/src-tauri/capabilities/default.json)):
it is the same web app as in the browser, just in a different frame. Menu, tray
and container startup run entirely in Rust.

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
only people who build the app need that.

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
  worker/     BullMQ — calendar and mail sync, uptime, CI/CD, digests, lead scores
  web/        Vue 3 + Vite + Tailwind — the interface
  mcp/        MCP server (stdio) for Claude Code / Claude Desktop
  desktop/    Tauri — the same interface as a macOS app, with menu and tray
packages/
  shared/     Zod schemas and formatters shared by API, web and MCP
```

Worker and API share the Prisma client and the service layer through relative
imports — one monorepo, one source of truth, no duplicated integrations.

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

## MCP server

Gives Claude access to the full dataset — day overview, search, projects,
timer, manual time entries, notes, meetings, leads and offers, inbox,
operational status, unbilled time, invoice drafts, revenue.

```bash
SOLOOPS_URL=http://localhost:3000 \
SOLOOPS_TOKEN=<SERVICE_TOKEN> \
claude mcp add soloops -- npx tsx /path/to/soloops/apps/mcp/src/index.ts
```

Available tools: `soloops_today`, `soloops_search`, `soloops_list_projects`,
`soloops_get_project`, `soloops_project_digest`, `soloops_timer_status`,
`soloops_timer_start`, `soloops_timer_stop`, `soloops_log_time`,
`soloops_time_report`, `soloops_free_slots`, `soloops_create_event`,
`soloops_list_meetings`, `soloops_get_meeting`, `soloops_summarize_meeting`,
`soloops_create_note`, `soloops_list_notes`, `soloops_ops_status`,
`soloops_unbilled_time`, `soloops_list_invoices`,
`soloops_draft_invoice_from_time`, `soloops_revenue`, `soloops_pipeline`,
`soloops_list_leads`, `soloops_get_lead`, `soloops_create_lead`,
`soloops_log_offer`, `soloops_log_lead_activity`, `soloops_set_lead_stage`,
`soloops_inbox`, `soloops_assign_mail`.

The writing tools are deliberately conservative:
`soloops_draft_invoice_from_time` only produces a draft — sending it and
transferring it to lexoffice stay manual.

---

## Authentication

Two ways into the API:

- **JWT** for the interface (`POST /api/auth/login`, valid for 30 days)
- **`SERVICE_TOKEN`** as a bearer token for the worker, the MCP server and the
  ICS feed

Passwords are hashed with scrypt (no native module required).

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
  account has to be reconnected — by design.

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
