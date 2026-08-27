import type { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { expandRecurrence } from './recurrence.js'

/**
 * Termine eines Zeitraums — inklusive aufgespannter Serien.
 *
 * Bewusst an einer Stelle: Kalender und Dashboard müssen dasselbe zeigen.
 * Als das Aufspannen nur in der Kalenderroute lag, meldete das Dashboard
 * einen freien Tag, an dem der Kalender zwei Termine hatte.
 */

const DEFAULT_INCLUDE = {
  project: { select: { id: true, key: true, name: true, color: true } },
  client: { select: { id: true, name: true } },
  meeting: { select: { id: true, status: true } },
  links: { select: { accountId: true } },
} satisfies Prisma.CalendarEventInclude

export type ReadEvent = Prisma.CalendarEventGetPayload<{ include: typeof DEFAULT_INCLUDE }> & {
  /** Gesetzt, wenn dies eine erzeugte Wiederholung ist — zeigt auf die Serie. */
  occurrenceOf?: string
}

export async function listEventsInRange(
  from: Date,
  to: Date,
  opts: { projectId?: string; take?: number } = {},
): Promise<ReadEvent[]> {
  const where = opts.projectId ? { projectId: opts.projectId } : {}

  const [single, series] = await Promise.all([
    prisma.calendarEvent.findMany({
      where: { ...where, rrule: null, startsAt: { lt: to }, endsAt: { gt: from } },
      include: DEFAULT_INCLUDE,
      orderBy: { startsAt: 'asc' },
    }),
    // Serien unabhängig vom Fenster: ihr Startdatum liegt oft Jahre zurück,
    // die Wiederholungen aber mitten drin.
    prisma.calendarEvent.findMany({
      where: { ...where, rrule: { not: null }, startsAt: { lt: to } },
      include: DEFAULT_INCLUDE,
    }),
  ])

  // Überschriebene Einzelinstanzen verdrängen die erzeugte Wiederholung.
  const overrides = new Set(
    single
      .filter((e) => e.sourceUid && e.recurrenceId)
      .map((e) => `${e.sourceUid}|${e.recurrenceId!.getTime()}`),
  )

  const expanded: ReadEvent[] = series.flatMap((event) => {
    const durationMs = Math.max(0, event.endsAt.getTime() - event.startsAt.getTime())
    return expandRecurrence({
      rrule: event.rrule!,
      dtstart: event.startsAt,
      durationMs,
      timeZone: event.timeZone,
      exDates: event.exDates,
      windowStart: from,
      windowEnd: to,
    })
      .filter((o) => !overrides.has(`${event.sourceUid}|${o.start.getTime()}`))
      .map((o) => ({
        ...event,
        // Virtuelle Instanz: eigene Id für die Liste, erkennbar abgeleitet.
        // Sie existiert nicht als Zeile in der Datenbank.
        id: `${event.id}@${o.start.toISOString()}`,
        occurrenceOf: event.id,
        startsAt: o.start,
        endsAt: o.end,
        readOnly: true,
      }))
  })

  const all = [...single, ...expanded].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  return opts.take ? all.slice(0, opts.take) : all
}
