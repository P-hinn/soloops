/**
 * A minimal iCalendar parser for the CalDAV sync.
 *
 * Deliberately covers only what events need: VEVENT with SUMMARY,
 * DTSTART/DTEND (including TZID and VALUE=DATE), DESCRIPTION, LOCATION, UID,
 * LAST-MODIFIED, SEQUENCE and the conference URL. RRULE is recognised but not
 * expanded — those events are marked as a series and never written back
 * (see calendarSync.ts).
 */

import { utcOf } from './tz.js'

export type ParsedEvent = {
  uid: string
  summary: string
  description: string | null
  location: string | null
  startsAt: Date
  endsAt: Date
  allDay: boolean
  recurring: boolean
  videoUrl: string | null
  lastModified: Date | null
  sequence: number
  /** The raw RRULE if there is one — expanded on read. */
  rrule: string | null
  /** DTSTART's TZID. Series have to be computed in their own zone. */
  timeZone: string | null
  /** EXDATE entries: excluded start times. */
  exDates: Date[]
  /** Set when this VEVENT overrides a single instance. */
  recurrenceId: Date | null
}

/** Unfold lines: continuations start with a space or tab (RFC 5545 §3.1). */
function unfold(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const out: string[] = []
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) {
      out[out.length - 1] += line.slice(1)
    } else if (line.length) {
      out.push(line)
    }
  }
  return out
}

function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

type Prop = { name: string; params: Record<string, string>; value: string }

function parseProp(line: string): Prop | null {
  const colon = indexOfUnquoted(line, ':')
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const [name, ...paramParts] = head.split(';')
  const params: Record<string, string> = {}
  for (const part of paramParts) {
    const eq = part.indexOf('=')
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: (name ?? '').toUpperCase(), params, value }
}

/** Colons inside quotes do not count as separators. */
function indexOfUnquoted(text: string, char: string): number {
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') quoted = !quoted
    else if (c === char && !quoted) return i
  }
  return -1
}

/** DTSTART/DTEND in all three notations. */
export function parseIcsDate(prop: Prop): { date: Date; allDay: boolean } | null {
  const value = prop.value.trim()

  // VALUE=DATE:20260811 — all-day
  if (prop.params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const y = Number(value.slice(0, 4))
    const mo = Number(value.slice(4, 6))
    const d = Number(value.slice(6, 8))
    if (!y) return null
    return { date: new Date(Date.UTC(y, mo - 1, d)), allDay: true }
  }

  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value)
  if (!m) return null
  const [, ys, mos, ds, hs, mis, ss, zulu] = m
  const y = Number(ys)
  const mo = Number(mos)
  const d = Number(ds)
  const h = Number(hs)
  const mi = Number(mis)
  const s = Number(ss)

  if (zulu) return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false }

  const tzid = prop.params.TZID
  if (tzid) {
    try {
      return { date: utcOf({ y, mo, d, h, mi, s }, tzid), allDay: false }
    } catch {
      // Unknown TZID: read it as UTC rather than lose the event.
    }
  }
  // Floating time: treat it as UTC.
  return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false }
}

/** Takes an .ics resource and returns every VEVENT it contains. */
export function parseIcs(raw: string): ParsedEvent[] {
  const lines = unfold(raw)
  const events: ParsedEvent[] = []

  let current: Prop[] | null = null
  for (const line of lines) {
    if (line.toUpperCase().startsWith('BEGIN:VEVENT')) {
      current = []
      continue
    }
    if (line.toUpperCase().startsWith('END:VEVENT')) {
      if (current) {
        const parsed = buildEvent(current)
        if (parsed) events.push(parsed)
      }
      current = null
      continue
    }
    if (current) {
      const prop = parseProp(line)
      if (prop) current.push(prop)
    }
  }
  return events
}

function buildEvent(props: Prop[]): ParsedEvent | null {
  const get = (name: string) => props.find((p) => p.name === name)
  const uid = get('UID')?.value?.trim()
  const dtstart = get('DTSTART')
  if (!uid || !dtstart) return null

  const start = parseIcsDate(dtstart)
  if (!start) return null

  const dtend = get('DTEND')
  let end = dtend ? parseIcsDate(dtend) : null

  if (!end) {
    // DURATION instead of DTEND, or nothing at all: fill in something sane.
    const duration = get('DURATION')?.value
    const ms = duration ? parseDuration(duration) : null
    end = {
      date: new Date(start.date.getTime() + (ms ?? (start.allDay ? 86_400_000 : 3_600_000))),
      allDay: start.allDay,
    }
  }

  // Conference URL: CONFERENCE (RFC 7986), X-GOOGLE-CONFERENCE or from the text.
  const description = get('DESCRIPTION')?.value ? unescapeText(get('DESCRIPTION')!.value) : null
  const videoUrl =
    get('X-GOOGLE-CONFERENCE')?.value?.trim() ||
    get('CONFERENCE')?.value?.trim() ||
    findMeetingUrl(description) ||
    findMeetingUrl(get('LOCATION')?.value ?? null)

  const lastModifiedProp = get('LAST-MODIFIED') ?? get('DTSTAMP')
  const lastModified = lastModifiedProp ? (parseIcsDate(lastModifiedProp)?.date ?? null) : null

  const rrule = get('RRULE')?.value?.trim() ?? null
  const recurrenceIdProp = get('RECURRENCE-ID')
  const exDates = props
    .filter((p) => p.name === 'EXDATE')
    .flatMap((p) =>
      p.value
        .split(',')
        .map((v) => parseIcsDate({ ...p, value: v.trim() })?.date)
        .filter((d): d is Date => !!d),
    )

  return {
    uid,
    rrule,
    timeZone: dtstart.params.TZID ?? null,
    exDates,
    recurrenceId: recurrenceIdProp ? (parseIcsDate(recurrenceIdProp)?.date ?? null) : null,
    summary: unescapeText(get('SUMMARY')?.value ?? '(ohne Titel)'),
    description,
    location: get('LOCATION')?.value ? unescapeText(get('LOCATION')!.value) : null,
    startsAt: start.date,
    endsAt: end.date,
    allDay: start.allDay,
    recurring: !!rrule,
    videoUrl: videoUrl || null,
    lastModified,
    sequence: Number(get('SEQUENCE')?.value ?? 0) || 0,
  }
}

/** An ISO 8601 duration as it appears in DURATION: PT1H30M, P1D … */
function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim().toUpperCase(),
  )
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms =
    (Number(w ?? 0) * 604800 +
      Number(d ?? 0) * 86400 +
      Number(h ?? 0) * 3600 +
      Number(mi ?? 0) * 60 +
      Number(s ?? 0)) *
    1000
  return sign === '-' ? -ms : ms
}

const MEETING_HOSTS =
  /(meet\.jit\.si|zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|whereby\.com|webex\.com|bigbluebutton)/i

function findMeetingUrl(text: string | null): string | null {
  if (!text) return null
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const url = match[0].replace(/[.,;)]+$/, '')
    if (MEETING_HOSTS.test(url)) return url
  }
  return null
}

// ---------------------------------------------------------------------------
// The writing direction: emit a local event as an .ics resource
// ---------------------------------------------------------------------------

function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

function stampUtc(d: Date, dateOnly = false): string {
  const iso = d.toISOString()
  return dateOnly
    ? iso.slice(0, 10).replace(/-/g, '')
    : `${iso.replace(/[-:]/g, '').split('.')[0] ?? ''}Z`
}

function fold(line: string): string {
  if (line.length <= 73) return line
  const chunks = [line.slice(0, 73)]
  let rest = line.slice(73)
  while (rest.length > 72) {
    chunks.push(' ' + rest.slice(0, 72))
    rest = rest.slice(72)
  }
  if (rest) chunks.push(' ' + rest)
  return chunks.join('\r\n')
}

export type IcsEventInput = {
  externalUid: string
  title: string
  description: string | null
  location: string | null
  startsAt: Date
  endsAt: Date
  allDay: boolean
  videoUrl: string | null
  updatedAt: Date
}

/** A complete VCALENDAR resource with exactly one VEVENT. */
export function buildEventIcs(event: IcsEventInput, sequence = 0): string {
  const description = [event.description, event.videoUrl ? `Videoraum: ${event.videoUrl}` : null]
    .filter(Boolean)
    .join('\n\n')

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//soloops//Kalender//DE',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${event.externalUid}@soloops`,
    `DTSTAMP:${stampUtc(new Date())}`,
    `SEQUENCE:${sequence}`,
    event.allDay
      ? `DTSTART;VALUE=DATE:${stampUtc(event.startsAt, true)}`
      : `DTSTART:${stampUtc(event.startsAt)}`,
    event.allDay
      ? `DTEND;VALUE=DATE:${stampUtc(event.endsAt, true)}`
      : `DTEND:${stampUtc(event.endsAt)}`,
    fold(`SUMMARY:${escapeText(event.title)}`),
    `LAST-MODIFIED:${stampUtc(event.updatedAt)}`,
  ]
  if (description) lines.push(fold(`DESCRIPTION:${escapeText(description)}`))
  if (event.location) lines.push(fold(`LOCATION:${escapeText(event.location)}`))
  if (event.videoUrl) {
    lines.push(fold(`URL:${event.videoUrl}`))
    lines.push(fold(`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${event.videoUrl}`))
  }
  lines.push('END:VEVENT', 'END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
