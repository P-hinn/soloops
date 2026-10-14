# Activity: what the Mac sees

A stopwatch assumes you remember to press it when you switch tasks. The day
band takes the other route: the macOS app measures what was worked on, and that
should eventually become time entries you only have to confirm.

**Stage 1 — measured and visible.** What exists today: recording, storage and
display. Mapping to projects follows.

## What gets measured

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

## Why no AI

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

## Privacy

- **Off by default.** `ACTIVITY_TRACKING=false`; the tray checkbox switches at
  runtime and takes effect on the next tick.
- **Blocklist.** Apps listed in `ACTIVITY_PRIVATE_APPS` (password managers,
  banking, messengers) are stored without a title. The time range stays
  visible, the content does not.
- **Forgetful.** The worker deletes anything older than
  `ACTIVITY_RETENTION_DAYS` (30 by default) overnight. Individual segments can
  be removed from the day band immediately with ✕.
- **Local only.** The app posts samples to `127.0.0.1` and nowhere else.

## When the API isn't running

The app buffers line by line into `data/activity-pending.jsonl` and sends once
a minute. If the containers are down or the app is quit, the buffer is still
there on the next start; only after roughly four days of backlog does the
oldest fall off. Sending happens over a raw HTTP request — the whole feature
adds no Rust dependency at all.
