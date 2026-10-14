# Two-way calendar sync

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

## How conflicts are decided

Every link remembers two states: what was last written out, and what was last
pulled in. That lets the sync recognise an event it pushed itself and not write
it again — otherwise the two systems would ping-pong forever.

If **both sides** changed since the last run, the newer timestamp wins. Nothing
is merged field by field, and the decision ends up in the log and in the sync
message. Deletions leave a tombstone so they still propagate once the local
event is already gone.

## What gets written, and what doesn't

Exactly one account carries the **target calendar** flag. Only events created
in soloops go there. An event that came from calendar A is never copied to
calendar B — otherwise every entry would multiply across all connected
calendars.

**Remote deletion only happens with explicit per-account consent**, off by
default. A misclick in soloops should not remove events from all your devices.

## Two deliberate limits

- **CalDAV series are read-only.** They appear as a single event, are marked
  read-only and are never written back. Handling recurrence rules correctly in
  both directions (exceptions, moved instances, timezone changes) is a project
  of its own. With Google the question doesn't arise, because instances are
  what gets synced.
- **Without WebDAV sync, the CalDAV fallback cannot detect deletions.** An
  event deleted on the Apple side would stay put locally. Rather than guessing
  (and losing events outside the sync window in the process), soloops keeps it
  and shows a warning when the account is connected.
