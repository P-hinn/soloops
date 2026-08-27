import { utcOf, wallOf, type Wall } from './tz.js'

/**
 * RRULE-Expansion (RFC 5545, praxisnahe Teilmenge).
 *
 * Gerechnet wird in der Ursprungszone der Serie, nicht in Millisekunden:
 * "jeden Montag 10 Uhr" bleibt sonst über die Zeitumstellung hinweg nicht
 * 10 Uhr. Deshalb wandern wir in Kalendereinheiten durch die Wanduhrzeit und
 * rechnen erst am Ende nach UTC.
 *
 * Unterstützt: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY, INTERVAL, COUNT, UNTIL,
 * BYDAY (mit Ordinal, z.B. -1FR), BYMONTHDAY, BYMONTH, BYSETPOS (±1).
 * Nicht unterstützt: BYWEEKNO, BYYEARDAY, BYHOUR/BYMINUTE. Solche Regeln
 * liefern die Serienstart-Instanz und werden nicht weiter aufgefächert.
 */

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export type ParsedRule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | null
  interval: number
  count: number | null
  until: Date | null
  byDay: { ordinal: number | null; weekday: number }[]
  byMonthDay: number[]
  byMonth: number[]
  bySetPos: number[]
}

export function parseRRule(rrule: string): ParsedRule {
  const parts = new Map<string, string>()
  for (const chunk of rrule.replace(/^RRULE:/i, '').split(';')) {
    const eq = chunk.indexOf('=')
    if (eq > 0) parts.set(chunk.slice(0, eq).toUpperCase(), chunk.slice(eq + 1))
  }

  const freqRaw = parts.get('FREQ')?.toUpperCase()
  const freq =
    freqRaw === 'DAILY' || freqRaw === 'WEEKLY' || freqRaw === 'MONTHLY' || freqRaw === 'YEARLY'
      ? freqRaw
      : null

  const untilRaw = parts.get('UNTIL')
  let until: Date | null = null
  if (untilRaw) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?$/.exec(untilRaw.trim())
    if (m) {
      until = new Date(
        Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3]),
          Number(m[4] ?? 23),
          Number(m[5] ?? 59),
          Number(m[6] ?? 59),
        ),
      )
    }
  }

  const byDay = (parts.get('BYDAY') ?? '')
    .split(',')
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean)
    .map((token) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(token)
      if (!m) return null
      const weekday = WEEKDAYS.indexOf(m[2] as (typeof WEEKDAYS)[number])
      if (weekday < 0) return null
      return { ordinal: m[1] ? Number(m[1]) : null, weekday }
    })
    .filter((v): v is { ordinal: number | null; weekday: number } => v !== null)

  // Achtung: ''.split(',') liefert [''] und Number('') ist 0. Ohne das
  // Herausfiltern leerer Teile wird aus einem fehlenden BYMONTHDAY ein [0] —
  // und der Monatszweig sucht dann nach dem nullten Tag des Monats.
  const numbers = (key: string) =>
    (parts.get(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
      .map(Number)
      .filter((v) => Number.isFinite(v) && v !== 0)

  return {
    freq,
    interval: Math.max(1, Number(parts.get('INTERVAL') ?? 1) || 1),
    count: parts.has('COUNT') ? Number(parts.get('COUNT')) : null,
    until,
    byDay,
    byMonthDay: numbers('BYMONTHDAY'),
    byMonth: numbers('BYMONTH'),
    bySetPos: numbers('BYSETPOS'),
  }
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/** Wochentag (0=So) eines Kalendertags, unabhängig von Zonen. */
function weekdayOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

/** Alle Tage eines Monats, die auf einen der BYDAY-Wochentage fallen. */
function monthDaysMatchingByDay(y: number, mo: number, rule: ParsedRule): number[] {
  const out: number[] = []
  const total = daysInMonth(y, mo)
  for (const spec of rule.byDay) {
    const matching: number[] = []
    for (let d = 1; d <= total; d++) {
      if (weekdayOf(y, mo, d) === spec.weekday) matching.push(d)
    }
    if (spec.ordinal === null) {
      out.push(...matching)
    } else {
      const idx = spec.ordinal > 0 ? spec.ordinal - 1 : matching.length + spec.ordinal
      const day = matching[idx]
      if (day) out.push(day)
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/** BYSETPOS wählt aus den Kandidaten eines Zeitraums (z.B. "letzter Werktag"). */
function applySetPos(days: number[], rule: ParsedRule): number[] {
  if (!rule.bySetPos.length) return days
  const picked = rule.bySetPos
    .map((pos) => (pos > 0 ? days[pos - 1] : days[days.length + pos]))
    .filter((d): d is number => d !== undefined)
  return [...new Set(picked)].sort((a, b) => a - b)
}

export type Occurrence = { start: Date; end: Date }

/**
 * Termine einer Serie im Fenster [windowStart, windowEnd).
 *
 * `exDates` sind die ausgenommenen Starttermine (EXDATE und überschriebene
 * Einzeltermine per RECURRENCE-ID).
 */
export function expandRecurrence(opts: {
  rrule: string
  dtstart: Date
  durationMs: number
  timeZone: string | null
  exDates?: Date[]
  windowStart: Date
  windowEnd: Date
  /** Notbremse gegen fehlerhafte Regeln. */
  maxOccurrences?: number
}): Occurrence[] {
  const rule = parseRRule(opts.rrule)
  const max = opts.maxOccurrences ?? 800
  const out: Occurrence[] = []

  // Ohne erkannte Frequenz nur die Ursprungsinstanz — besser als raten.
  if (!rule.freq) {
    return withinWindow(
      [{ start: opts.dtstart, end: new Date(opts.dtstart.getTime() + opts.durationMs) }],
      opts,
    )
  }

  const exact = new Set((opts.exDates ?? []).map((d) => d.getTime()))
  const base = wallOf(opts.dtstart, opts.timeZone)
  const hardEnd = rule.until && rule.until < opts.windowEnd ? rule.until : opts.windowEnd

  let emitted = 0 // zählt ALLE Instanzen seit dtstart, für COUNT
  let iterations = 0

  const emit = (w: Wall): 'continue' | 'stop' => {
    const start = utcOf(w, opts.timeZone)
    if (start < opts.dtstart) return 'continue'
    if (rule.until && start > rule.until) return 'stop'

    emitted++
    if (rule.count !== null && emitted > rule.count) return 'stop'

    if (!exact.has(start.getTime())) {
      const end = new Date(start.getTime() + opts.durationMs)
      if (end > opts.windowStart && start < opts.windowEnd) out.push({ start, end })
    }
    return start >= opts.windowEnd ? 'stop' : 'continue'
  }

  if (rule.freq === 'DAILY') {
    const cursor: Wall = { ...base }
    while (iterations++ < max * 4) {
      const state = emit(cursor)
      if (state === 'stop') break
      const next = new Date(Date.UTC(cursor.y, cursor.mo - 1, cursor.d))
      next.setUTCDate(next.getUTCDate() + rule.interval)
      cursor.y = next.getUTCFullYear()
      cursor.mo = next.getUTCMonth() + 1
      cursor.d = next.getUTCDate()
      if (utcOf(cursor, opts.timeZone) > hardEnd) break
    }
  } else if (rule.freq === 'WEEKLY') {
    const weekdays = rule.byDay.length
      ? [...new Set(rule.byDay.map((b) => b.weekday))].sort((a, b) => a - b)
      : [weekdayOf(base.y, base.mo, base.d)]

    // Montag der Startwoche als Anker
    const startWeekday = weekdayOf(base.y, base.mo, base.d)
    const anchor = new Date(Date.UTC(base.y, base.mo - 1, base.d))
    anchor.setUTCDate(anchor.getUTCDate() - ((startWeekday + 6) % 7))

    outer: while (iterations++ < max) {
      for (const wd of weekdays) {
        const day = new Date(anchor)
        day.setUTCDate(day.getUTCDate() + ((wd + 6) % 7))
        const w: Wall = {
          ...base,
          y: day.getUTCFullYear(),
          mo: day.getUTCMonth() + 1,
          d: day.getUTCDate(),
        }
        if (emit(w) === 'stop') break outer
      }
      anchor.setUTCDate(anchor.getUTCDate() + 7 * rule.interval)
      if (
        Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()) >
        hardEnd.getTime()
      )
        break
    }
  } else {
    // MONTHLY und YEARLY teilen sich die Kandidatenlogik pro Monat.
    const stepMonths = rule.freq === 'MONTHLY' ? rule.interval : rule.interval * 12
    let y = base.y
    let mo = base.mo

    outer2: while (iterations++ < max) {
      const months = rule.freq === 'YEARLY' && rule.byMonth.length ? rule.byMonth : [mo]

      for (const month of months) {
        let candidates: number[]
        if (rule.byDay.length) candidates = monthDaysMatchingByDay(y, month, rule)
        else if (rule.byMonthDay.length) {
          candidates = rule.byMonthDay
            .map((d) => (d > 0 ? d : daysInMonth(y, month) + d + 1))
            .filter((d) => d >= 1 && d <= daysInMonth(y, month))
            .sort((a, b) => a - b)
        } else {
          // Ohne BY-Regel: derselbe Monatstag wie der Serienstart.
          // Der 31. existiert nicht in jedem Monat — solche Monate fallen aus,
          // genau wie es RFC 5545 vorschreibt.
          candidates = base.d <= daysInMonth(y, month) ? [base.d] : []
        }

        for (const d of applySetPos(candidates, rule)) {
          if (emit({ ...base, y, mo: month, d }) === 'stop') break outer2
        }
      }

      const next = new Date(Date.UTC(y, mo - 1 + stepMonths, 1))
      y = next.getUTCFullYear()
      mo = next.getUTCMonth() + 1
      if (Date.UTC(y, mo - 1, 1) > hardEnd.getTime()) break
    }
  }

  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

function withinWindow(
  occurrences: Occurrence[],
  opts: { windowStart: Date; windowEnd: Date },
): Occurrence[] {
  return occurrences.filter((o) => o.end > opts.windowStart && o.start < opts.windowEnd)
}
