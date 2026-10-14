# Inbox and lead matching

soloops reads an existing mailbox over IMAP and matches mail to leads, clients
and projects. Set it up under _Settings_ with server, user and password; the
host is guessed from the address (Strato, mailbox.org, Posteo, IONOS, All-Inkl
and Gmail are known). The password is encrypted at rest, like the calendar
credentials.

**Read-only, strictly.** There is no delete, no move and no flag setting in the
code — not even "mark as read". Your mail client cannot tell that something is
reading along, and a bug in soloops cannot damage the mailbox. Headers and
bodies are stored, attachments are not.

## Rules before AI

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

## Two deliberate limits

- **A mail never becomes a lead automatically.** That is a button in the inbox.
  Otherwise the first marketing mail containing the word "offer" creates one.
- **Mail content is never rendered as Markdown.** Neither the text itself nor
  what the AI derives from it — both go out as plain text. Otherwise a crafted
  mail would be a way to get script into your own interface.
  `MarkdownBlock.vue` stays reserved for your own content.

## Follow-ups

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
