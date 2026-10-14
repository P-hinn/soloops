# Modules

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

**Tasks.** The same open points as a **list** and as a **board**, switchable in
the header. The deadline is optional; what has one is sorted by it and reads as
"heute", "2 T über", "in 5 T" rather than a date you have to count from. Tasks
belong to a project and a customer — the customer comes from the project unless
you say otherwise — and **that is what makes them billable**: the stopwatch can
be started on a ticket, takes the project from it, and the hours land on the
card and on the invoice through the same time entry as always. A task without a
project is a note with a date; time needs a project, because that is where the
hourly rate hangs.

Four columns: Backlog, in Arbeit, blockiert, erledigt. Drag and drop sorts
within a column and moves between them; two arrows on every card do the same
without a mouse. Only three of the columns are a status — the last one is the
`done` flag the to-dos always had. That is deliberate: a second field meaning
"finished" would drift away from the first the moment the phone ticks something
off, since the sync merges field by field. The pleasant side effect is that
dragging a card back out of _erledigt_ returns it to the column it came from.

**Tasks and leads.** A follow-up on a lead carries its own ticket: put a lead
on follow-up and the card appears in the backlog with that date, moving the
date moves the card, and ticking the card off counts as having chased the lead
up — it writes "Nachgefasst" into the lead's history and takes the date off,
exactly as the button on the lead does. That also means a follow-up can be
time-tracked like anything else, which it could not before.

Only the ticket the follow-up made for itself behaves that way (`source =
"LEAD"`). A task you write yourself and hang on a lead keeps the reference,
shows up under that lead, and is yours — chasing the lead up does not tick it
off. Removing a follow-up as a wrong date removes its card too, unless time
has been booked on it, in which case it is closed rather than deleted: booked
hours are history and do not disappear.

**Tasks and the repository.** A ticket can carry the commits, pull requests and
issues that belong to it: paste the URL out of the browser (or the short
`owner/repo#12` / `owner/repo@abc123` form), and the task shows a chip with
title and state — _offen_, _Entwurf_, _gemerged_, _geschlossen_. GitHub and
GitLab, read through `GITHUB_TOKEN` / `GITLAB_TOKEN`; without a token for that
host the link is still stored, just without the title. Reading only — a to-do
list that can close other people's pull requests is a to-do list nobody should
hand a token to. "Aktualisieren" re-reads the state, which is how a card
answers "is it merged by now".

**Sales.** Leads in four open stages (new, qualified, offer, negotiation) plus
won and lost. Every lead records **what you offered for what**: title, amount,
scope, sent on, valid until. Once an offer is out, its amount counts as the
value of the lead — a number on paper is more reliable than a guess from the
first call. Sending an offer advances the stage on its own.

Follow-ups are the other half: a date, a reason, and from there a ticket on
the task board — see **Tasks** above.

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
client > global default. A timer started on a task books on the task **and** on
its project, so the ticket shows what it has cost and the invoice is unaffected
by any of it.

There is deliberately no password manager — that is what 1Password is for.
soloops only stores the credentials it needs for its own syncing (calendar
tokens, encrypted at rest).

**Activity.** The day band at the bottom of _Zeiten_: what ran on the Mac, as
stripes over an hour axis, with the segments spelled out underneath. Mapping to
projects is the next stage — for now this is the raw material. See
[Activity](activity.md).

**Invoices.** "Create from time" takes all open, billable entries of a client
in the period, groups them per project and links the time entries firmly to the
line item — so nothing lands on two invoices. The PDF is rendered server-side
with pdfkit (close to DIN 5008, with the §19 UStG note if configured).
Sequential numbering per year. Issued invoices are locked and can only be
cancelled.

**Accounting.** A lexoffice adapter: create contacts, transfer invoices as
finalized documents (`finalize=true`), monthly revenue net/VAT/gross for the
advance VAT return.

**Contracts.** NDA, Werkvertrag, Dienstvertrag and freie Mitarbeit, sent for
signature from the customer list: pick the type, fill in what differs per
contract, and n8n renders the template, turns it into a PDF through Gotenberg
and hands it to Zoho Sign for both signatures. What comes back lands in
soloops — the "Signatur ausstehend" task ticks itself off, a note records it,
and the signed PDF shows up under _Verträge_ with everything else that is out
and everything that came back. There is no contracts table: a contract is two
notes and a task, which means it syncs to the phone and shows up in search
without anything new being built for it. See
[vertragsautomatisierung/README.md](../vertragsautomatisierung/README.md).

**Automations.** A full n8n under _Automatisierungen_ — its drag-and-drop
canvas embedded in soloops, soloops nodes in its palette, templates to start
from, and the run and delivery logs that say whether any of it is still
working. See [Automations](automations.md).
