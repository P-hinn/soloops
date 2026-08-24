/**
 * Umrechnung zwischen Wanduhrzeit in einer benannten Zone und UTC.
 *
 * Wird an zwei Stellen gebraucht: beim Lesen von DTSTART mit TZID und beim
 * Aufspannen von Serien. Serien müssen in ihrer Ursprungszone gerechnet werden —
 * "jeden Montag 10 Uhr" heißt über die Sommerzeit hinweg eben nicht "alle
 * 604800000 Millisekunden".
 */

export type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** Wanduhr-Bestandteile eines Zeitpunkts in einer Zone. */
export function partsInZone(instant: Date, timeZone: string): Wall {
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
  return {
    y: parts.year ?? 1970,
    mo: parts.month ?? 1,
    d: parts.day ?? 1,
    h: parts.hour ?? 0,
    mi: parts.minute ?? 0,
    s: parts.second ?? 0,
  }
}

/** Versatz einer Zone zu einem Zeitpunkt, in Millisekunden. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const w = partsInZone(instant, timeZone)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - instant.getTime()
}

/**
 * Wanduhrzeit -> UTC. Zwei Durchläufe, weil der Versatz selbst vom Ergebnis
 * abhängt: an Umstellungstagen liefert der erste Versuch den falschen Offset.
 */
export function zonedToUtc(w: Wall, timeZone: string): Date {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  const first = zoneOffsetMs(new Date(naive), timeZone)
  let ms = naive - first
  const second = zoneOffsetMs(new Date(ms), timeZone)
  if (second !== first) ms = naive - second
  return new Date(ms)
}

/** Ohne Zone: als UTC lesen. Hält die Aufrufer frei von Fallunterscheidungen. */
export function wallOf(instant: Date, timeZone: string | null): Wall {
  if (timeZone) {
    try {
      return partsInZone(instant, timeZone)
    } catch {
      // Unbekannte TZID — lieber UTC als gar nichts.
    }
  }
  return {
    y: instant.getUTCFullYear(),
    mo: instant.getUTCMonth() + 1,
    d: instant.getUTCDate(),
    h: instant.getUTCHours(),
    mi: instant.getUTCMinutes(),
    s: instant.getUTCSeconds(),
  }
}

export function utcOf(w: Wall, timeZone: string | null): Date {
  if (timeZone) {
    try {
      return zonedToUtc(w, timeZone)
    } catch {
      // s.o.
    }
  }
  return new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s))
}
