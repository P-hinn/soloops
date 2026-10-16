import type { CalendarAccount, CalendarEvent, EventLink } from '@prisma/client'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { open, seal } from './secretbox.js'
import * as google from './google.js'
import * as caldav from './caldav.js'
import { buildEventIcs, parseIcs } from './icsParse.js'

/**
 * Two-way sync with Google Calendar and Apple/iCloud (CalDAV).
 *
 * Ground rules that hold everywhere:
 *
 * 1. Every link remembers two states: `pushedUpdatedAt` (what we last wrote
 *    out) and `remoteUpdatedAt` (what we last pulled in). That is exactly
 *    what prevents echo loops — an event we just pushed comes back on the
 *    next pull and is recognised instead of written again.
 * 2. A conflict means both sides changed since the last run. The newer
 *    timestamp then wins, and the decision is logged. No silent merging of
 *    individual fields.
 * 3. New events go exclusively to the calendar marked as the target, and
 *    remote deletion only happens with explicit consent.
 * 4. Series from remote calendars are read-only. Google expands them into
 *    individual events through `singleEvents=true`, so it is a non-issue
 *    there. With CalDAV the series lands as one event with `readOnly = true`.
 */

const PULL_PAST_DAYS = 90
const PULL_FUTURE_DAYS = 365

export type SyncResult = {
  account: string
  provider: string
  pulled: number
  pushed: number
  deletedRemote: number
  deletedLocal: number
  conflicts: number
  skippedSeries: number
  error?: string
}

function windowStart(): Date {
  return new Date(Date.now() - PULL_PAST_DAYS * 86_400_000)
}
function windowEnd(): Date {
  return new Date(Date.now() + PULL_FUTURE_DAYS * 86_400_000)
}

/** Map a UID we wrote ourselves back onto the local identifier. */
function localUidFrom(uid: string): string | null {
  const m = /^(.+)@soloops$/.exec(uid)
  return m?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export async function syncAccount(accountId: string): Promise<SyncResult> {
  const account = await prisma.calendarAccount.findUniqueOrThrow({ where: { id: accountId } })
  const result: SyncResult = {
    account: account.label,
    provider: account.provider,
    pulled: 0,
    pushed: 0,
    deletedRemote: 0,
    deletedLocal: 0,
    conflicts: 0,
    skippedSeries: 0,
  }

  try {
    if (account.provider === 'GOOGLE') await syncGoogle(account, result)
    else await syncCaldav(account, result)

    await prisma.calendarAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date(), lastError: null },
    })
  } catch (err) {
    result.error = (err as Error).message
    await prisma.calendarAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date(), lastError: result.error.slice(0, 500) },
    })
  }
  return result
}

export async function syncAllAccounts(): Promise<SyncResult[]> {
  const accounts = await prisma.calendarAccount.findMany({ where: { enabled: true } })
  const results: SyncResult[] = []
  for (const account of accounts) results.push(await syncAccount(account.id))
  return results
}

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

/** Fetch an access token, refreshing it when needed (and storing the refresh). */
async function googleToken(account: CalendarAccount): Promise<string> {
  if (!account.accessTokenEnc) throw new Error('Kein Google-Token gespeichert')

  const stillValid = account.tokenExpiresAt && account.tokenExpiresAt.getTime() > Date.now()
  if (stillValid) return open(account.accessTokenEnc)

  if (!account.refreshTokenEnc) {
    throw new Error('Google-Token abgelaufen und kein Refresh-Token vorhanden — neu verbinden')
  }
  const fresh = await google.refreshAccessToken(open(account.refreshTokenEnc))
  await prisma.calendarAccount.update({
    where: { id: account.id },
    data: { accessTokenEnc: seal(fresh.accessToken), tokenExpiresAt: fresh.expiresAt },
  })
  return fresh.accessToken
}

async function syncGoogle(account: CalendarAccount, result: SyncResult): Promise<void> {
  const token = await googleToken(account)
  const calendarId = account.remoteCalendarId ?? 'primary'

  if (account.direction !== 'PUSH') {
    let changes: Awaited<ReturnType<typeof google.listChanges>>
    try {
      changes = await google.listChanges(token, calendarId, account.syncToken, windowStart())
    } catch (err) {
      if ((err as Error).name !== 'GoogleSyncTokenGone') throw err
      // The token expired: read everything once more.
      console.warn(`[sync] ${account.label}: syncToken verfallen, Vollabgleich`)
      changes = await google.listChanges(token, calendarId, null, windowStart())
    }

    for (const remote of changes.events) {
      if (remote.status === 'cancelled') {
        const removed = await removeLocalByRemoteId(account.id, remote.id)
        if (removed) result.deletedLocal++
        continue
      }
      const start = remote.start?.dateTime ?? remote.start?.date
      const end = remote.end?.dateTime ?? remote.end?.date
      if (!start || !end) continue

      const allDay = !remote.start?.dateTime
      await applyRemote(account, result, {
        remoteId: remote.id,
        remoteEtag: remote.etag ?? null,
        remoteUpdatedAt: remote.updated ? new Date(remote.updated) : new Date(),
        localHint: remote.extendedProperties?.private?.soloopsEventId ?? null,
        title: remote.summary ?? '(ohne Titel)',
        description: remote.description ?? null,
        location: remote.location ?? null,
        startsAt: new Date(start),
        endsAt: new Date(end),
        allDay,
        videoUrl: google.meetLink(remote),
        // singleEvents=true yields instances — those are editable one by one.
        recurring: !!remote.recurringEventId,
        readOnly: false,
      })
      result.pulled++
    }

    if (changes.nextSyncToken) {
      await prisma.calendarAccount.update({
        where: { id: account.id },
        data: { syncToken: changes.nextSyncToken },
      })
    }
  }

  if (account.direction === 'PULL') return

  // --- Deletions first, so that a newly created event cannot overtake them.
  // Without consent the tombstones stay and the remote calendar is untouched.
  if (account.allowRemoteDelete) {
    for (const stone of await prisma.syncTombstone.findMany({ where: { accountId: account.id } })) {
      await google.deleteEvent(token, calendarId, stone.remoteId)
      await prisma.syncTombstone.delete({ where: { id: stone.id } })
      result.deletedRemote++
    }
  }

  for (const event of await pushCandidates(account)) {
    const link = event.links[0] ?? null
    const input: google.GoogleEventInput = {
      summary: event.title,
      description: descriptionWithVideo(event),
      location: event.location,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      localId: event.id,
      // Meet only on creation, and only when no link is set yet
      withMeet: !link && event.videoProvider === 'GOOGLE_MEET' && !event.videoUrl,
    }

    let remote: google.GoogleEvent
    try {
      remote = link
        ? await google.patchEvent(token, calendarId, link.remoteId, input)
        : await google.insertEvent(token, calendarId, input)
    } catch (err) {
      // A single event the remote side rejects must not stop the whole sync.
      // Note it, skip it, carry on.
      result.conflicts++
      console.warn(
        `[sync] ${account.label}: "${event.title}" abgelehnt — ${(err as Error).message}`,
      )
      await markPushed(account.id, event)
      continue
    }

    // Google created a Meet room -> adopt it locally
    const meet = google.meetLink(remote)
    if (meet && !event.videoUrl) {
      await prisma.calendarEvent.update({
        where: { id: event.id },
        data: { videoUrl: meet, videoProvider: 'GOOGLE_MEET' },
      })
    }

    await linkUp(account.id, event, remote.id, remote.etag ?? null, remote.updated)
    result.pushed++
  }
}

// ---------------------------------------------------------------------------
// CalDAV (Apple/iCloud)
// ---------------------------------------------------------------------------

function caldavCreds(account: CalendarAccount): caldav.CalDavCredentials {
  if (!account.caldavBaseUrl || !account.caldavUsername || !account.caldavPassEnc) {
    throw new Error('CalDAV-Zugangsdaten unvollständig')
  }
  return {
    baseUrl: account.caldavBaseUrl,
    username: account.caldavUsername,
    password: open(account.caldavPassEnc),
  }
}

async function syncCaldav(account: CalendarAccount, result: SyncResult): Promise<void> {
  const creds = caldavCreds(account)
  const calendarHref = account.remoteCalendarId
  if (!calendarHref) throw new Error('Kein Kalender ausgewählt')

  if (account.direction !== 'PUSH') {
    let changed: caldav.CalDavResource[]
    let nextToken: string | null
    let sawDeletions = false

    const sync = await caldav
      .syncCollection(creds, calendarHref, account.syncToken)
      .catch(() => ({ resources: [], syncToken: null, needsFullSync: true }))

    if (!sync.needsFullSync) {
      changed = sync.resources
      nextToken = sync.syncToken
      sawDeletions = true
    } else {
      // Without WebDAV sync the only option is comparing every ETag in the window.
      const listed = await caldav.listEtags(creds, calendarHref, windowStart(), windowEnd())
      const links = await prisma.eventLink.findMany({ where: { accountId: account.id } })
      const known = new Map(links.map((l) => [l.remoteId, l.remoteEtag]))
      changed = listed.filter((r) => known.get(r.href) !== r.etag)
      // Deletions cannot be detected reliably that way (window boundaries) —
      // we deliberately do not guess and leave them in place.
      nextToken = null
    }

    for (const resource of changed.filter((r) => r.deleted)) {
      if (!sawDeletions) continue
      const removed = await removeLocalByRemoteId(account.id, resource.href)
      if (removed) result.deletedLocal++
    }

    const toFetch = changed.filter((r) => !r.deleted).map((r) => r.href)
    const fetched = await caldav.multiget(creds, calendarHref, toFetch)

    for (const resource of fetched) {
      if (!resource.data) continue
      for (const parsed of parseIcs(resource.data)) {
        if (parsed.recurring) result.skippedSeries++
        await applyRemote(account, result, {
          remoteId: resource.href,
          remoteEtag: resource.etag,
          remoteUpdatedAt: parsed.lastModified ?? new Date(),
          localHint: localUidFrom(parsed.uid),
          title: parsed.summary,
          description: parsed.description,
          location: parsed.location,
          startsAt: parsed.startsAt,
          endsAt: parsed.endsAt,
          allDay: parsed.allDay,
          videoUrl: parsed.videoUrl,
          recurring: parsed.recurring,
          // Series and overridden single instances stay read-only: writing
          // them back as a standalone VEVENT would take the series on the
          // remote side apart.
          readOnly: parsed.recurring || parsed.recurrenceId !== null,
          sourceUid: parsed.uid,
          rrule: parsed.rrule,
          timeZone: parsed.timeZone,
          exDates: parsed.exDates,
          recurrenceId: parsed.recurrenceId,
        })
        result.pulled++
        break // one resource = one event (do not expand series)
      }
    }

    await prisma.calendarAccount.update({
      where: { id: account.id },
      data: { syncToken: nextToken },
    })
  }

  if (account.direction === 'PULL') return

  // Delete in the remote calendar only where that was explicitly allowed.
  if (account.allowRemoteDelete) {
    for (const stone of await prisma.syncTombstone.findMany({ where: { accountId: account.id } })) {
      await caldav.deleteEvent(creds, stone.remoteId, stone.remoteEtag)
      await prisma.syncTombstone.delete({ where: { id: stone.id } })
      result.deletedRemote++
    }
  }

  for (const event of await pushCandidates(account)) {
    const link = event.links[0] ?? null
    const href = link?.remoteId ?? caldav.resourceHref(calendarHref, event.externalUid)
    const ics = buildEventIcs(
      {
        externalUid: event.externalUid,
        title: event.title,
        description: event.description,
        location: event.location,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: event.allDay,
        videoUrl: event.videoUrl,
        updatedAt: event.updatedAt,
      },
      Math.floor(event.updatedAt.getTime() / 1000) % 100000,
    )

    let put: Awaited<ReturnType<typeof caldav.putEvent>>
    try {
      put = await caldav.putEvent(creds, href, ics, link?.remoteEtag ?? null)
    } catch (err) {
      // A single event was rejected (say, the UID already exists there):
      // note it and carry on instead of aborting the whole calendar.
      result.conflicts++
      console.warn(
        `[sync] ${account.label}: "${event.title}" abgelehnt — ${(err as Error).message}`,
      )
      await markPushed(account.id, event)
      continue
    }
    if (put.conflict) {
      // The remote side was faster. On the next pull the newer state wins.
      result.conflicts++
      console.warn(`[sync] ${account.label}: Konflikt bei "${event.title}" — Pull entscheidet`)
      await markPushed(account.id, event)
      continue
    }
    await linkUp(account.id, event, href, put.etag, undefined)
    result.pushed++
  }
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------

type RemoteEvent = {
  remoteId: string
  remoteEtag: string | null
  remoteUpdatedAt: Date
  /** The local event id or externalUid, if the event came from us. */
  localHint: string | null
  title: string
  description: string | null
  location: string | null
  startsAt: Date
  endsAt: Date
  allDay: boolean
  videoUrl: string | null
  recurring: boolean
  readOnly: boolean
  // Series metadata; always empty for Google, which sends instances.
  sourceUid?: string | null
  rrule?: string | null
  timeZone?: string | null
  exDates?: Date[]
  recurrenceId?: Date | null
}

/** Apply a remote event locally — create, update or discard. */
async function applyRemote(
  account: CalendarAccount,
  result: SyncResult,
  remote: RemoteEvent,
): Promise<void> {
  const existingLink = await prisma.eventLink.findUnique({
    where: { accountId_remoteId: { accountId: account.id, remoteId: remote.remoteId } },
    include: { event: true },
  })

  const payload = {
    title: remote.title,
    description: remote.description,
    location: remote.location,
    startsAt: remote.startsAt,
    endsAt: remote.endsAt,
    allDay: remote.allDay,
    videoUrl: remote.videoUrl,
    recurring: remote.recurring,
    readOnly: remote.readOnly,
    sourceUid: remote.sourceUid ?? null,
    rrule: remote.rrule ?? null,
    timeZone: remote.timeZone ?? null,
    exDates: remote.exDates ?? [],
    recurrenceId: remote.recurrenceId ?? null,
  }

  if (existingLink) {
    const local = existingLink.event
    const localChanged =
      !existingLink.pushedUpdatedAt || local.updatedAt > existingLink.pushedUpdatedAt
    const remoteIsNewer =
      !existingLink.remoteUpdatedAt || remote.remoteUpdatedAt > existingLink.remoteUpdatedAt

    if (!remoteIsNewer) return // nothing new from the remote side

    if (localChanged && local.updatedAt > remote.remoteUpdatedAt) {
      // Both changed, local is newer -> keep local, the push sorts it out.
      result.conflicts++
      console.warn(
        `[sync] ${account.label}: "${local.title}" beidseitig geändert — lokale Version gewinnt`,
      )
      await prisma.eventLink.update({
        where: { id: existingLink.id },
        data: { remoteEtag: remote.remoteEtag, remoteUpdatedAt: remote.remoteUpdatedAt },
      })
      return
    }

    if (localChanged) result.conflicts++
    const updated = await prisma.calendarEvent.update({ where: { id: local.id }, data: payload })
    await prisma.eventLink.update({
      where: { id: existingLink.id },
      data: {
        remoteEtag: remote.remoteEtag,
        remoteUpdatedAt: remote.remoteUpdatedAt,
        // The local state now equals the remote one: do not push again.
        pushedUpdatedAt: updated.updatedAt,
      },
    })
    // And for ALL accounts: the change came from outside, it is not an edit
    // by the user. Without this, every other connected account would take the
    // event for locally changed and write it out again.
    await prisma.eventLink.updateMany({
      where: { eventId: local.id, id: { not: existingLink.id } },
      data: { pushedUpdatedAt: updated.updatedAt },
    })
    return
  }

  // No link: did the event originally come from us?
  const own = remote.localHint
    ? await prisma.calendarEvent.findFirst({
        where: { OR: [{ id: remote.localHint }, { externalUid: remote.localHint }] },
      })
    : null

  const event =
    own ??
    (await prisma.calendarEvent.create({
      data: { ...payload, kind: remote.recurring ? 'ADMIN' : 'MEETING' },
    }))

  if (own) {
    // Only the link was missing — do not overwrite the local state.
    await prisma.eventLink.create({
      data: {
        accountId: account.id,
        eventId: event.id,
        remoteId: remote.remoteId,
        remoteEtag: remote.remoteEtag,
        remoteUpdatedAt: remote.remoteUpdatedAt,
        pushedUpdatedAt: event.updatedAt,
      },
    })
  } else {
    await prisma.eventLink.create({
      data: {
        accountId: account.id,
        eventId: event.id,
        remoteId: remote.remoteId,
        remoteEtag: remote.remoteEtag,
        remoteUpdatedAt: remote.remoteUpdatedAt,
        pushedUpdatedAt: event.updatedAt,
      },
    })
  }
}

/** Remove a local event because it was deleted on the remote side. */
async function removeLocalByRemoteId(accountId: string, remoteId: string): Promise<boolean> {
  const link = await prisma.eventLink.findUnique({
    where: { accountId_remoteId: { accountId, remoteId } },
  })
  if (!link) return false

  // Leave a tombstone for the *other* accounts so the deletion propagates.
  const others = await prisma.eventLink.findMany({
    where: { eventId: link.eventId, accountId: { not: accountId } },
  })
  for (const other of others) {
    await prisma.syncTombstone.upsert({
      where: { accountId_remoteId: { accountId: other.accountId, remoteId: other.remoteId } },
      create: {
        accountId: other.accountId,
        remoteId: other.remoteId,
        remoteEtag: other.remoteEtag,
      },
      update: {},
    })
  }

  await prisma.calendarEvent.delete({ where: { id: link.eventId } }).catch(() => {})
  return true
}

type EventWithLinks = CalendarEvent & { links: EventLink[] }

/**
 * The events this account is supposed to write.
 *
 * Origin is what matters: an event that came from calendar A must not be
 * copied into calendar B — otherwise, with several calendars connected, every
 * event multiplies across all of them. So we only write what was created
 * here, plus changes to what this account already knows.
 */
async function pushCandidates(account: CalendarAccount): Promise<EventWithLinks[]> {
  const events = await prisma.calendarEvent.findMany({
    where: {
      readOnly: false,
      startsAt: { gte: windowStart(), lte: windowEnd() },
    },
    // Every link, not just our own — otherwise an event's origin cannot be
    // told.
    include: { links: true },
    orderBy: { startsAt: 'asc' },
  })

  return (
    events
      .filter((event) => {
        const mine = event.links.find((l) => l.accountId === account.id)
        if (mine) {
          // Known: write again only on a real change.
          if (!mine.pushedUpdatedAt) return true
          return event.updatedAt.getTime() > mine.pushedUpdatedAt.getTime() + 1000
        }
        // Unknown: only the target calendar takes new events, and only those
        // that did not come from another remote calendar.
        return account.isDefault && event.links.length === 0
      })
      // The rest of the code expects `links` to hold this account's link.
      .map((event) => ({ ...event, links: event.links.filter((l) => l.accountId === account.id) }))
  )
}

/**
 * After a rejected push, record the state so that the same event is not
 * retried on every run and the same error repeated.
 */
async function markPushed(accountId: string, event: CalendarEvent): Promise<void> {
  await prisma.eventLink
    .updateMany({
      where: { accountId, eventId: event.id },
      data: { pushedUpdatedAt: event.updatedAt },
    })
    .catch(() => {})
}

async function linkUp(
  accountId: string,
  event: CalendarEvent,
  remoteId: string,
  remoteEtag: string | null,
  remoteUpdated: string | undefined,
): Promise<void> {
  // Order matters: writing `lastPushedAt` also bumps `updatedAt` through
  // @updatedAt. If we stamped the link first, the event would look "locally
  // changed" again straight afterwards and be written out on every run — an
  // endless loop on a ten-minute beat.
  const current = await prisma.calendarEvent.update({
    where: { id: event.id },
    data: { lastPushedAt: new Date() },
  })

  const stamp = {
    remoteId,
    remoteEtag,
    remoteUpdatedAt: remoteUpdated ? new Date(remoteUpdated) : new Date(),
    pushedUpdatedAt: current.updatedAt,
  }
  await prisma.eventLink.upsert({
    where: { accountId_eventId: { accountId, eventId: event.id } },
    create: { accountId, eventId: event.id, ...stamp },
    update: stamp,
  })
}

/** Mirror the video room into the description so it shows in remote calendars. */
function descriptionWithVideo(event: CalendarEvent): string | null {
  if (!event.videoUrl) return event.description
  const line = `Videoraum: ${event.videoUrl}`
  if (event.description?.includes(event.videoUrl)) return event.description
  return [event.description, line].filter(Boolean).join('\n\n')
}

/**
 * Call before deleting locally: records what still has to be removed from the
 * remote calendars.
 */
export async function tombstoneEvent(eventId: string): Promise<void> {
  const links = await prisma.eventLink.findMany({ where: { eventId } })
  for (const link of links) {
    await prisma.syncTombstone.upsert({
      where: { accountId_remoteId: { accountId: link.accountId, remoteId: link.remoteId } },
      create: { accountId: link.accountId, remoteId: link.remoteId, remoteEtag: link.remoteEtag },
      update: {},
    })
  }
}

export const syncWindow = { start: windowStart, end: windowEnd, tz: env.TZ }
