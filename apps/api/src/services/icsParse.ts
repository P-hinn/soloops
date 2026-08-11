/**
 * Minimaler iCalendar-Parser für den CalDAV-Sync.
 *
 * Deckt bewusst nur ab, was für Termine gebraucht wird: VEVENT mit SUMMARY,
 * DTSTART/DTEND (inkl. TZID und VALUE=DATE), DESCRIPTION, LOCATION, UID,
 * LAST-MODIFIED, SEQUENCE und die Konferenz-URL. RRULE wird erkannt, aber
 * nicht expandiert — solche Termine markieren wir als Serie und schreiben sie
 * nie zurück (siehe calendarSync.ts).
 */

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
}

/** Zeilen entfalten: Fortsetzungen beginnen mit Space oder Tab (RFC 5545 §3.1). */
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

/** Doppelpunkte innerhalb von Anführungszeichen zählen nicht als Trenner. */
function indexOfUnquoted(text: string, char: string): number {
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') quoted = !quoted
    else if (c === char && !quoted) return i
  }
  return -1
}

/** Offset einer Zeitzone zum gegebenen Zeitpunkt, in Millisekunden. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, number> = {}
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  const asUtc = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  )
  return asUtc - instant.getTime()
}

/**
 * Wandelt eine Wanduhrzeit in einer benannten Zone nach UTC.
 * Zwei Durchläufe, weil der Offset selbst vom Ergebnis abhängt (Sommerzeit).
 */
function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s)
  const first = zoneOffsetMs(new Date(naive), timeZone)
  let ms = naive - first
  const second = zoneOffsetMs(new Date(ms), timeZone)
  if (second !== first) ms = naive - second
  return new Date(ms)
}

/** DTSTART/DTEND in allen drei Schreibweisen. */
export function parseIcsDate(prop: Prop): { date: Date; allDay: boolean } | null {
  const value = prop.value.trim()

  // VALUE=DATE:20260811 — ganztägig
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
      return { date: zonedToUtc(y, mo, d, h, mi, s, tzid), allDay: false }
    } catch {
      // Unbekannte TZID: als UTC lesen statt den Termin zu verlieren.
    }
  }
  // Floating time: als UTC behandeln.
  return { date: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), allDay: false }
}

/** Nimmt eine .ics-Ressource und liefert alle enthaltenen VEVENTs. */
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
    // DURATION statt DTEND, oder gar nichts: sinnvoll ergänzen.
    const duration = get('DURATION')?.value
    const ms = duration ? parseDuration(duration) : null
    end = {
      date: new Date(start.date.getTime() + (ms ?? (start.allDay ? 86_400_000 : 3_600_000))),
      allDay: start.allDay,
    }
  }

  // Konferenz-URL: CONFERENCE (RFC 7986), X-GOOGLE-CONFERENCE oder aus dem Text.
  const description = get('DESCRIPTION')?.value ? unescapeText(get('DESCRIPTION')!.value) : null
  const videoUrl =
    get('X-GOOGLE-CONFERENCE')?.value?.trim() ||
    get('CONFERENCE')?.value?.trim() ||
    findMeetingUrl(description) ||
    findMeetingUrl(get('LOCATION')?.value ?? null)

  const lastModifiedProp = get('LAST-MODIFIED') ?? get('DTSTAMP')
  const lastModified = lastModifiedProp ? (parseIcsDate(lastModifiedProp)?.date ?? null) : null

  return {
    uid,
    summary: unescapeText(get('SUMMARY')?.value ?? '(ohne Titel)'),
    description,
    location: get('LOCATION')?.value ? unescapeText(get('LOCATION')!.value) : null,
    startsAt: start.date,
    endsAt: end.date,
    allDay: start.allDay,
    recurring: props.some((p) => p.name === 'RRULE' || p.name === 'RECURRENCE-ID'),
    videoUrl: videoUrl || null,
    lastModified,
    sequence: Number(get('SEQUENCE')?.value ?? 0) || 0,
  }
}

/** ISO-8601-Dauer, wie sie in DURATION steht: PT1H30M, P1D … */
function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim().toUpperCase(),
  )
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms =
    (Number(w ?? 0) * 604800 + Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi ?? 0) * 60 + Number(s ?? 0)) *
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
// Schreibrichtung: einen lokalen Termin als .ics-Ressource ausgeben
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

/** Eine vollständige VCALENDAR-Ressource mit genau einem VEVENT. */
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
