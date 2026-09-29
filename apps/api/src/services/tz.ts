/**
 * Conversion between wall-clock time in a named zone and UTC.
 *
 * Needed in two places: reading DTSTART with a TZID, and expanding series.
 * Series have to be computed in their original zone — across a daylight
 * saving change, "every Monday at 10" is emphatically not "every 604800000
 * milliseconds".
 */

export type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number }

/** The wall-clock parts of an instant in a given zone. */
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

/** A zone's offset at a given instant, in milliseconds. */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const w = partsInZone(instant, timeZone)
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) - instant.getTime()
}

/**
 * Wall clock -> UTC. Two passes, because the offset itself depends on the
 * result: on transition days the first attempt returns the wrong offset.
 */
export function zonedToUtc(w: Wall, timeZone: string): Date {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s)
  const first = zoneOffsetMs(new Date(naive), timeZone)
  let ms = naive - first
  const second = zoneOffsetMs(new Date(ms), timeZone)
  if (second !== first) ms = naive - second
  return new Date(ms)
}

/** No zone: read it as UTC. Keeps the callers free of special cases. */
export function wallOf(instant: Date, timeZone: string | null): Wall {
  if (timeZone) {
    try {
      return partsInZone(instant, timeZone)
    } catch {
      // Unknown TZID — UTC beats nothing at all.
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
      // see above
    }
  }
  return new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s))
}
