# Automations with n8n

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

## Setup

1. `npm run up` brings n8n along. First visit asks for an owner account —
   that is n8n's own, unrelated to the soloops login.
2. In n8n: **Settings → n8n API → Create an API key**. Paste it into
   _Automatisierungen → Verbindungen_. It cannot be set from the outside, so
   this step cannot be skipped; soloops checks the key against n8n before
   storing it (encrypted, see `services/secretbox.ts`).
   Without it the Builder still works — flows, templates and monitoring stay
   empty.
3. Still under _Verbindungen_: store the **n8n account**, so soloops can sign
   you in and the embedded editor stops asking for a second login. Checked
   against n8n before it is kept, and sealed with the same box as the IMAP
   password. Skip it and nothing breaks — the editor simply shows n8n's own
   login the first time.
4. Also under _Verbindungen_: create an **automation token**. It is shown
   once. In n8n under **Credentials → soloops API**, paste it with base URL
   `http://api:3000`.

The token is deliberately not the `SERVICE_TOKEN`: that one also opens the
macOS app and the MCP server and cannot be revoked without taking both down.
An automation token is revocable on its own, can be read-only, and reaches
**only** `/api/automations/connector` — see [Authentication](authentication.md).

## The second login, and why it is handled this way

n8n brings its own user management. In version 2 it cannot be switched off,
and the embed login that would solve this properly sits behind an enterprise
licence. So being signed in to soloops is made to be enough the only way left:
soloops signs in for you. The API logs in with the stored account and relays
n8n's own session cookie to the browser; since n8n is served from this origin
under `/n8n/`, the browser sends it along to the editor by itself.

The request deliberately carries no browser-id header. n8n binds a session to
the browser that asked for it when one is sent, and this one is asked for by
the API on your behalf — a token bound to the server would be refused by the
browser it is meant for.

What this costs: soloops holds an n8n password, and a soloops compromise is
therefore an n8n compromise. Given n8n runs arbitrary code on the same host
and soloops already holds the database, that is a short step rather than a new
one — but it is a real one. With n8n MFA enabled it does not work at all, and
the editor goes back to asking.

## The connector

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

## Events

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
| `task.completed`     | an open task is ticked, or dropped into _erledigt_             |
| `note.created`       | a note is created                                              |

They are emitted from the service layer, not from one route, so a lead moved
through the interface, through Claude and through a workflow all produce the
same events. A trigger with no project set takes everything of its kind; one
scoped to a project takes only that project's events — and deliberately not
events belonging to no project at all.

A delivery carries `X-Soloops-Signature`, an HMAC-SHA256 of the exact body
under a secret handed over at registration, so the receiving end can tell a
real call from a replayed one.

## Monitoring

The canvas can take over the window — **Vollbild** in the Builder, out again
with the button or Shift+Esc. The application's own full screen, not the
operating system's: it covers the sidebar, the header and the tabs while
leaving the menu bar and the Dock alone. Plain Esc is deliberately left to
n8n, which uses it to close an open node. Expanding restyles the frame rather
than moving it, so nothing reloads and an unsaved canvas survives.

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

## Templates

Six ready-made workflows under _Vorlagen_, built on the soloops nodes — won
lead becomes a project, new lead into a chat, stage changes logged on the lead,
follow-up after a meeting, a lost lead resurfacing in six months, a morning
pipeline digest. One click creates one in n8n.

They land **inactive** on purpose: a template cannot know which credential to
use — n8n credentials live in n8n — so the honest end of an import is "here it
is, open it".
