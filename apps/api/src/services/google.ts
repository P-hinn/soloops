import { randomUUID } from 'node:crypto'
import { env } from '../env.js'

/**
 * Google Calendar API v3 — nur die Teile, die für den 2-Wege-Sync nötig sind.
 *
 * Scope ist bewusst nur `calendar`: Lesen und Schreiben von Terminen und das
 * Auflisten der Kalender, nichts weiter. Keine Kontakte, kein Gmail.
 */

const SCOPE = 'https://www.googleapis.com/auth/calendar'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const API = 'https://www.googleapis.com/calendar/v3'

export type GoogleTokens = {
  accessToken: string
  refreshToken: string | null
  expiresAt: Date
}

export type GoogleCalendarInfo = {
  id: string
  summary: string
  primary: boolean
  accessRole: string
}

export type GoogleEvent = {
  id: string
  etag?: string
  status?: string // confirmed | tentative | cancelled
  summary?: string
  description?: string
  location?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  updated?: string
  recurringEventId?: string
  recurrence?: string[]
  htmlLink?: string
  hangoutLink?: string
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
  extendedProperties?: { private?: Record<string, string> }
}

export function googleConfigured(): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

function requireConfig(): { id: string; secret: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET nicht gesetzt')
  }
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET }
}

/** Consent-URL. `state` schützt gegen CSRF im Callback. */
export function authUrl(state: string): string {
  const { id } = requireConfig()
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', id)
  url.searchParams.set('redirect_uri', env.GOOGLE_REDIRECT_URI)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPE)
  // offline + consent, damit wirklich ein Refresh-Token kommt
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)
  return url.toString()
}

export async function exchangeCode(code: string): Promise<GoogleTokens> {
  const { id, secret } = requireConfig()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })
  if (!res.ok) throw new Error(`Google Token-Tausch: HTTP ${res.status} ${await res.text()}`)
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
  }
}

export async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const { id, secret } = requireConfig()
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: id,
      client_secret: secret,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    throw new Error(
      `Google Token-Erneuerung: HTTP ${res.status} — Konto neu verbinden. ${(await res.text()).slice(0, 200)}`,
    )
  }
  const json = (await res.json()) as { access_token: string; expires_in: number }
  return {
    accessToken: json.access_token,
    refreshToken,
    expiresAt: new Date(Date.now() + (json.expires_in - 60) * 1000),
  }
}

async function call<T>(
  accessToken: string,
  path: string,
  init: RequestInit & { query?: Record<string, string | undefined> } = {},
): Promise<T> {
  const url = new URL(`${API}${path}`)
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body,
  })

  if (res.status === 410) {
    // syncToken abgelaufen — der Aufrufer muss voll neu abgleichen.
    const err = new Error('GOOGLE_SYNC_TOKEN_GONE')
    err.name = 'GoogleSyncTokenGone'
    throw err
  }
  if (!res.ok) {
    throw new Error(
      `Google Calendar ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    )
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarInfo[]> {
  const json = await call<{ items?: GoogleCalendarInfo[] }>(accessToken, '/users/me/calendarList')
  return (json.items ?? []).filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer')
}

/**
 * Inkrementeller Abgleich. Ohne syncToken wird ab `timeMin` voll gelesen und
 * am Ende ein Token zurückgegeben.
 *
 * `singleEvents=true` löst Serien in Einzeltermine auf. Das ist der Grund,
 * warum Google-Serien hier vollständig funktionieren, CalDAV-Serien nicht.
 */
export async function listChanges(
  accessToken: string,
  calendarId: string,
  syncToken: string | null,
  timeMin: Date,
): Promise<{ events: GoogleEvent[]; nextSyncToken: string | null }> {
  const events: GoogleEvent[] = []
  let pageToken: string | undefined
  let nextSyncToken: string | null = null

  do {
    const json = await call<{
      items?: GoogleEvent[]
      nextPageToken?: string
      nextSyncToken?: string
    }>(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
      query: {
        maxResults: '250',
        showDeleted: 'true',
        singleEvents: 'true',
        pageToken,
        // timeMin und orderBy dürfen nicht zusammen mit syncToken gesendet werden
        ...(syncToken ? { syncToken } : { timeMin: timeMin.toISOString() }),
      },
    })
    events.push(...(json.items ?? []))
    pageToken = json.nextPageToken
    nextSyncToken = json.nextSyncToken ?? nextSyncToken
  } while (pageToken)

  return { events, nextSyncToken }
}

export type GoogleEventInput = {
  summary: string
  description: string | null
  location: string | null
  startsAt: Date
  endsAt: Date
  allDay: boolean
  localId: string
  /** true => Google soll einen Meet-Raum erzeugen */
  withMeet: boolean
}

function toGoogleBody(input: GoogleEventInput): Record<string, unknown> {
  const dateOnly = (d: Date) => d.toISOString().slice(0, 10)
  return {
    summary: input.summary,
    description: input.description ?? undefined,
    location: input.location ?? undefined,
    start: input.allDay
      ? { date: dateOnly(input.startsAt) }
      : { dateTime: input.startsAt.toISOString(), timeZone: env.TZ },
    end: input.allDay
      ? { date: dateOnly(input.endsAt) }
      : { dateTime: input.endsAt.toISOString(), timeZone: env.TZ },
    // Damit wir eigene Termine beim Zurücklesen wiedererkennen
    extendedProperties: { private: { soloopsEventId: input.localId } },
    ...(input.withMeet
      ? {
          conferenceData: {
            createRequest: {
              requestId: randomUUID(),
              conferenceSolutionKey: { type: 'hangoutsMeet' },
            },
          },
        }
      : {}),
  }
}

export async function insertEvent(
  accessToken: string,
  calendarId: string,
  input: GoogleEventInput,
): Promise<GoogleEvent> {
  return call<GoogleEvent>(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify(toGoogleBody(input)),
    query: input.withMeet ? { conferenceDataVersion: '1' } : {},
  })
}

export async function patchEvent(
  accessToken: string,
  calendarId: string,
  remoteId: string,
  input: GoogleEventInput,
): Promise<GoogleEvent> {
  return call<GoogleEvent>(
    accessToken,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(toGoogleBody({ ...input, withMeet: false })),
    },
  )
}

export async function deleteEvent(
  accessToken: string,
  calendarId: string,
  remoteId: string,
): Promise<void> {
  try {
    await call<void>(
      accessToken,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(remoteId)}`,
      { method: 'DELETE' },
    )
  } catch (err) {
    // 404/410: schon gelöscht. Alles andere weiterwerfen.
    if (!/HTTP 40[049]|HTTP 410|SYNC_TOKEN_GONE/.test((err as Error).message)) throw err
  }
}

/** Meet-Link aus einem Google-Event ziehen, egal in welchem Feld er steckt. */
export function meetLink(event: GoogleEvent): string | null {
  if (event.hangoutLink) return event.hangoutLink
  const video = event.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')
  return video?.uri ?? null
}
