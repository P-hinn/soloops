import type { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { expandRecurrence } from './recurrence.js'

/**
 * The events of a period — expanded series included.
 *
 * Deliberately in one place: calendar and dashboard have to show the same
 * thing. While the expansion lived only in the calendar route, the dashboard
 * reported a free day on which the calendar had two events.
 */

const DEFAULT_INCLUDE = {
  project: { select: { id: true, key: true, name: true, color: true } },
  client: { select: { id: true, name: true } },
  meeting: { select: { id: true, status: true } },
  links: { select: { accountId: true } },
} satisfies Prisma.CalendarEventInclude

export type ReadEvent = Prisma.CalendarEventGetPayload<{ include: typeof DEFAULT_INCLUDE }> & {
  /** Set when this is a generated occurrence — points at the series. */
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
    // Series regardless of the window: their start date is often years back
    // while the occurrences sit right inside it.
    prisma.calendarEvent.findMany({
      where: { ...where, rrule: { not: null }, startsAt: { lt: to } },
      include: DEFAULT_INCLUDE,
    }),
  ])

  // Overridden single instances displace the generated occurrence.
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
        // A virtual instance: its own id for the list, recognisably derived.
        // It does not exist as a row in the database.
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
