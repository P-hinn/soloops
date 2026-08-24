/** Datums- und Layout-Helfer für die Kalenderansichten. */

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

/** Montag als Wochenanfang — deutsche Konvention. */
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

/** Minuten seit Mitternacht — Basis für die Positionierung im Zeitraster. */
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

/** ISO-Kalenderwoche (DIN 1355 / ISO 8601). */
export function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  // Donnerstag der laufenden Woche bestimmt das Jahr
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil(((d.getTime() - yearStart.getTime()) / MS_DAY + 1) / 7)
}

// ---------------------------------------------------------------------------
// Überlappungs-Layout
// ---------------------------------------------------------------------------

export type Placeable = { id: string; start: number; end: number }
export type Placed<T> = { item: T; column: number; columns: number }

/**
 * Verteilt sich überlappende Termine nebeneinander — wie in Apple Kalender.
 *
 * Zwei Durchgänge: erst werden Termine zu Clustern gruppiert, die sich
 * transitiv überschneiden, dann bekommt jeder Termin im Cluster die erste
 * freie Spalte. Die Spaltenzahl gilt für das ganze Cluster, damit die
 * Kacheln bündig sind statt unterschiedlich breit.
 */
export function layoutOverlaps<T extends Placeable>(items: T[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const result: Placed<T>[] = []

  let cluster: T[] = []
  let clusterEnd = -Infinity

  const flush = () => {
    if (!cluster.length) return
    // Spaltenbelegung: pro Spalte das Ende des letzten Termins
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
    // Mindestens 1 Minute Überlappung, damit direkt anschließende Termine
    // nicht künstlich nebeneinander landen.
    if (item.start >= clusterEnd) flush()
    cluster.push(item)
    clusterEnd = Math.max(clusterEnd, item.end)
  }
  flush()

  return result
}

// ---------------------------------------------------------------------------
// Farben
// ---------------------------------------------------------------------------

/** #rrggbb -> rgba(...) mit Alpha, für Füllungen auf Papier. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const int = parseInt(m[1]!, 16)
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`
}

/**
 * Lesbare Textfarbe zu einer Hintergrundfarbe (WCAG-Relativluminanz).
 * Bei Acid als Kalenderfarbe wäre weißer Text unlesbar.
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
 * Flächenstil eines Termins zu einer Kalenderfarbe.
 *
 * Eine feste Deckkraft funktioniert nicht für beide Enden der Palette: Acid
 * bei 16 % verschwindet auf Papier, Tinte bei 45 % wird zum schwarzen Klotz.
 * Deshalb entscheidet die Helligkeit über Füllung und Textfarbe.
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
    // Helle Farben taugen nicht als Schrift auf Papier — dann Tinte.
    color: isLight ? '#171714' : color,
  }
}
