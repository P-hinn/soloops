import type { CalendarAccount, CalendarEvent, EventLink } from '@prisma/client'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { open, seal } from './secretbox.js'
import * as google from './google.js'
import * as caldav from './caldav.js'
import { buildEventIcs, parseIcs } from './icsParse.js'

/**
 * Zwei-Wege-Abgleich mit Google Calendar und Apple/iCloud (CalDAV).
 *
 * Grundregeln, die überall gleich gelten:
 *
 * 1. Jede Verknüpfung merkt sich zwei Stände: `pushedUpdatedAt` (was wir
 *    zuletzt hinausgeschrieben haben) und `remoteUpdatedAt` (was wir zuletzt
 *    hereingeholt haben). Genau das verhindert Echo-Schleifen — ein Termin, den
 *    wir gerade gepusht haben, kommt beim nächsten Pull zurück und wird
 *    erkannt statt erneut geschrieben.
 * 2. Konflikt = beide Seiten haben sich seit dem letzten Abgleich geändert.
 *    Dann gewinnt der jüngere Zeitstempel, und die Entscheidung wird geloggt.
 *    Kein stilles Zusammenführen von Feldern.
 * 3. Neue Termine gehen ausschließlich in den als Ziel markierten Kalender,
 *    und gelöscht wird in der Gegenstelle nur mit ausdrücklicher Freigabe.
 * 4. Serien aus Fremdkalendern werden nur gelesen. Google löst sie über
 *    `singleEvents=true` in Einzeltermine auf, dort ist das kein Thema.
 *    Bei CalDAV landet die Serie als ein Termin mit `readOnly = true`.
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

/** UID, die wir selbst geschrieben haben, zurück auf die lokale Kennung mappen. */
function localUidFrom(uid: string): string | null {
  const m = /^(.+)@soloops$/.exec(uid)
  return m?.[1] ?? null
}

// ---------------------------------------------------------------------------
// Einstieg
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

/** Access-Token holen und bei Bedarf erneuern (und die Erneuerung speichern). */
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
      // Token verfallen: einmal komplett neu lesen.
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
        // singleEvents=true liefert Instanzen — die sind einzeln editierbar.
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

  // --- Löschungen zuerst, damit ein neu angelegter Termin sie nicht überholt.
  // Ohne Freigabe bleiben die Grabsteine liegen und der Fremdkalender unberührt.
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
      // Meet nur bei Neuanlage und nur, wenn noch kein Link gesetzt ist
      withMeet: !link && event.videoProvider === 'GOOGLE_MEET' && !event.videoUrl,
    }

    let remote: google.GoogleEvent
    try {
      remote = link
        ? await google.patchEvent(token, calendarId, link.remoteId, input)
        : await google.insertEvent(token, calendarId, input)
    } catch (err) {
      // Ein einzelner Termin, den die Gegenstelle ablehnt, darf nicht den
      // gesamten Abgleich stoppen. Merken, überspringen, weitermachen.
      result.conflicts++
      console.warn(
        `[sync] ${account.label}: "${event.title}" abgelehnt — ${(err as Error).message}`,
      )
      await markPushed(account.id, event)
      continue
    }

    // Google hat einen Meet-Raum erzeugt -> lokal übernehmen
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
      // Ohne WebDAV-Sync bleibt nur: alle ETags im Fenster vergleichen.
      const listed = await caldav.listEtags(creds, calendarHref, windowStart(), windowEnd())
      const links = await prisma.eventLink.findMany({ where: { accountId: account.id } })
      const known = new Map(links.map((l) => [l.remoteId, l.remoteEtag]))
      changed = listed.filter((r) => known.get(r.href) !== r.etag)
      // Löschungen lassen sich so nicht sicher erkennen (Fenstergrenzen) —
      // wir raten hier bewusst nicht und lassen sie stehen.
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
          // Serien und überschriebene Einzelinstanzen bleiben schreibgeschützt:
          // sie als eigenständigen VEVENT zurückzuschreiben würde die Serie
          // in der Gegenstelle zerlegen.
          readOnly: parsed.recurring || parsed.recurrenceId !== null,
          sourceUid: parsed.uid,
          rrule: parsed.rrule,
          timeZone: parsed.timeZone,
          exDates: parsed.exDates,
          recurrenceId: parsed.recurrenceId,
        })
        result.pulled++
        break // eine Ressource = ein Termin (Serien nicht expandieren)
      }
    }

    await prisma.calendarAccount.update({
      where: { id: account.id },
      data: { syncToken: nextToken },
    })
  }

  if (account.direction === 'PULL') return

  // Löschen im Fremdkalender nur, wenn dafür ausdrücklich freigegeben.
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
      // Einzelner Termin abgelehnt (z.B. UID existiert dort schon): notieren
      // und weitermachen, statt den ganzen Kalender abzubrechen.
      result.conflicts++
      console.warn(
        `[sync] ${account.label}: "${event.title}" abgelehnt — ${(err as Error).message}`,
      )
      await markPushed(account.id, event)
      continue
    }
    if (put.conflict) {
      // Die Gegenseite war schneller. Beim nächsten Pull gewinnt der jüngere Stand.
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
// Gemeinsame Bausteine
// ---------------------------------------------------------------------------

type RemoteEvent = {
  remoteId: string
  remoteEtag: string | null
  remoteUpdatedAt: Date
  /** Lokale Event-Id bzw. externalUid, falls der Termin von uns stammt. */
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
  // Serien-Metadaten; bei Google immer leer, weil dort Instanzen kommen.
  sourceUid?: string | null
  rrule?: string | null
  timeZone?: string | null
  exDates?: Date[]
  recurrenceId?: Date | null
}

/** Einen Fremdtermin lokal anwenden — anlegen, aktualisieren oder verwerfen. */
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

    if (!remoteIsNewer) return // nichts Neues von der Gegenseite

    if (localChanged && local.updatedAt > remote.remoteUpdatedAt) {
      // Beide geändert, lokal ist jünger -> lokal behalten, Push räumt es auf.
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
        // Der lokale Stand entspricht jetzt dem entfernten: nicht neu pushen.
        pushedUpdatedAt: updated.updatedAt,
      },
    })
    // Und zwar für ALLE Konten: die Änderung kam von außen, sie ist keine
    // Bearbeitung durch den Nutzer. Ohne das hält jedes andere verbundene
    // Konto den Termin für lokal geändert und schreibt ihn erneut hinaus.
    await prisma.eventLink.updateMany({
      where: { eventId: local.id, id: { not: existingLink.id } },
      data: { pushedUpdatedAt: updated.updatedAt },
    })
    return
  }

  // Kein Link: stammt der Termin ursprünglich von uns?
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
    // Nur die Verknüpfung fehlte — lokalen Stand nicht überschreiben.
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

/** Lokalen Termin entfernen, weil er in der Gegenstelle gelöscht wurde. */
async function removeLocalByRemoteId(accountId: string, remoteId: string): Promise<boolean> {
  const link = await prisma.eventLink.findUnique({
    where: { accountId_remoteId: { accountId, remoteId } },
  })
  if (!link) return false

  // Grabstein für *andere* Konten setzen, damit die Löschung weiterwandert.
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
 * Termine, die dieses Konto schreiben soll.
 *
 * Entscheidend ist die Herkunft: ein Termin, der aus Kalender A stammt, darf
 * nicht in Kalender B kopiert werden — sonst vervielfältigt sich bei mehreren
 * verbundenen Kalendern jeder Termin über alle hinweg. Geschrieben wird also
 * nur, was hier entstanden ist, plus Änderungen an dem, was dieses Konto
 * bereits kennt.
 */
async function pushCandidates(account: CalendarAccount): Promise<EventWithLinks[]> {
  const events = await prisma.calendarEvent.findMany({
    where: {
      readOnly: false,
      startsAt: { gte: windowStart(), lte: windowEnd() },
    },
    // Alle Verknüpfungen, nicht nur die eigene — sonst ist die Herkunft
    // eines Termins nicht erkennbar.
    include: { links: true },
    orderBy: { startsAt: 'asc' },
  })

  return (
    events
      .filter((event) => {
        const mine = event.links.find((l) => l.accountId === account.id)
        if (mine) {
          // Bekannt: nur bei echter Änderung erneut schreiben.
          if (!mine.pushedUpdatedAt) return true
          return event.updatedAt.getTime() > mine.pushedUpdatedAt.getTime() + 1000
        }
        // Unbekannt: nur der Zielkalender nimmt neue Termine auf, und nur solche,
        // die nicht aus einem anderen Fremdkalender stammen.
        return account.isDefault && event.links.length === 0
      })
      // Der Rest des Codes erwartet in `links` die Verknüpfung dieses Kontos.
      .map((event) => ({ ...event, links: event.links.filter((l) => l.accountId === account.id) }))
  )
}

/**
 * Nach einem abgelehnten Push den Stand festhalten, damit derselbe Termin
 * nicht bei jedem Lauf erneut versucht und derselbe Fehler wiederholt wird.
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
  // Reihenfolge ist entscheidend: `lastPushedAt` zu schreiben hebt über
  // @updatedAt auch `updatedAt` an. Stempelten wir die Verknüpfung vorher,
  // sähe der Termin gleich darauf wieder "lokal geändert" aus und würde bei
  // jedem Lauf erneut hinausgeschrieben — eine Endlosschleife im Zehnminutentakt.
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

/** Videoraum in die Beschreibung spiegeln, damit er im Fremdkalender sichtbar ist. */
function descriptionWithVideo(event: CalendarEvent): string | null {
  if (!event.videoUrl) return event.description
  const line = `Videoraum: ${event.videoUrl}`
  if (event.description?.includes(event.videoUrl)) return event.description
  return [event.description, line].filter(Boolean).join('\n\n')
}

/**
 * Vor dem lokalen Löschen aufrufen: merkt sich, was in den Fremdkalendern
 * noch entfernt werden muss.
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
