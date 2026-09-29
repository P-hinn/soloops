/** Date and layout helpers for the calendar views. */

export const MS_DAY = 86_400_000

export function startOfDay(d: Date): Date {
  const c = new Date(d)
  c.setHours(0, 0, 0, 0)
  return c
}

export function addDays(d: Date, n: number): Date {
  const c = new Date(d)
  c.setDate(c.getDate() + n)
  return c
}

export function addMonths(d: Date, n: number): Date {
  const c = new Date(d)
  c.setDate(1)
  c.setMonth(c.getMonth() + n)
  return c
}

/** Monday starts the week — the German convention. */
export function startOfWeek(d: Date): Date {
  const c = startOfDay(d)
  c.setDate(c.getDate() - ((c.getDay() + 6) % 7))
  return c
}

export function startOfMonth(d: Date): Date {
  const c = startOfDay(d)
  c.setDate(1)
  return c
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

export function isToday(d: Date): boolean {
  return isSameDay(d, new Date())
}

export function isWeekend(d: Date): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

/**
 * A calendar day as YYYY-MM-DD.
 *
 * All-day events are dates without a time; they are stored as UTC midnight.
 * Compare them against local day boundaries and every one of them spills into
 * the next day (by two hours at UTC+2). So the comparison happens at the date
 * level rather than on instants.
 */
export function dayKeyLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function dayKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** For all-day events DTEND is exclusive: 25th->26th means only the 25th. */
export function allDayCoversDay(startsAt: Date, endsAt: Date, day: Date): boolean {
  const key = dayKeyLocal(day)
  const from = dayKeyUtc(startsAt)
  const to = dayKeyUtc(endsAt)
  return key >= from && (key < to || from === to)
}

/** Minutes since midnight — the basis for positioning in the time grid. */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

export const fmtTime = (d: Date) =>
  d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
export const fmtWeekday = (d: Date) => d.toLocaleDateString('de-DE', { weekday: 'short' })
export const fmtWeekdayLong = (d: Date) => d.toLocaleDateString('de-DE', { weekday: 'long' })
export const fmtDate = (d: Date) => d.toLocaleDateString('de-DE')
export const fmtMonthYear = (d: Date) =>
  d.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })

/** ISO week number (DIN 1355 / ISO 8601). */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  // The Thursday of the current week determines the year
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / MS_DAY + 1) / 7)
}

// ---------------------------------------------------------------------------
// Overlap layout
// ---------------------------------------------------------------------------

export type Placeable = { id: string; start: number; end: number }
export type Placed<T> = { item: T; column: number; columns: number }

/**
 * Lays overlapping events out side by side — the way Apple Calendar does.
 *
 * Two passes: first events are grouped into clusters that overlap
 * transitively, then every event in a cluster takes the first free column.
 * The column count applies to the whole cluster, so the tiles line up
 * instead of varying in width.
 */
export function layoutOverlaps<T extends Placeable>(items: T[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const result: Placed<T>[] = []

  let cluster: T[] = []
  let clusterEnd = -Infinity

  const flush = () => {
    if (!cluster.length) return
    // Column occupancy: per column, the end of the last event
    const columnEnds: number[] = []
    const assigned = cluster.map((item) => {
      let column = columnEnds.findIndex((end) => end <= item.start)
      if (column === -1) {
        column = columnEnds.length
        columnEnds.push(item.end)
      } else {
        columnEnds[column] = item.end
      }
      return { item, column }
    })
    for (const a of assigned) result.push({ ...a, columns: columnEnds.length })
    cluster = []
    clusterEnd = -Infinity
  }

  for (const item of sorted) {
    // At least a minute of overlap, so that back-to-back events do not end
    // up side by side for no reason.
    if (item.start >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.end)
  }
  flush()

  return result
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** #rrggbb -> rgba(...) with alpha, for fills on paper. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const int = parseInt(m[1]!, 16)
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

/**
 * A readable text colour for a background (WCAG relative luminance).
 * With acid as the calendar colour, white text would be unreadable.
 */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#171714'
  const int = parseInt(m[1]!, 16)
  const srgb = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * srgb[0]! + 0.7152 * srgb[1]! + 0.0722 * srgb[2]!
  return luminance > 0.45 ? '#171714' : '#f1efe8'
}

/**
 * The surface style of an event for a given calendar colour.
 *
 * A fixed opacity does not work for both ends of the palette: acid at 16 %
 * disappears on paper, ink at 45 % turns into a black slab. So lightness
 * decides the fill and the text colour.
 */
export function chipStyle(color: string): {
  background: string
  borderColor: string
  color: string
} {
  const isLight = readableOn(color) === '#171714'
  return {
    background: withAlpha(color, isLight ? 0.5 : 0.14),
    borderColor: color,
    // Light colours are no good as type on paper — use ink instead.
    color: isLight ? '#171714' : color,
  }
}
