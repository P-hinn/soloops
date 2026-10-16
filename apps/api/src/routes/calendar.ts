import type { FastifyPluginAsyncZod, ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { eventInput, idParam } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { env } from '@soloops/core/env.js'
import { buildIcs } from '@soloops/core/services/ics.js'
import { tombstoneEvent } from '@soloops/core/services/calendarSync.js'
import { createVideoRoom } from '@soloops/core/services/video.js'
import { videoSettings } from '@soloops/core/settings.js'
import { listEventsInRange } from '@soloops/core/services/calendarRead.js'

const routes: FastifyPluginAsyncZod = async (app) => {
  /**
   * ICS feed for Apple/Google Calendar. Uses the SERVICE_TOKEN as a query
   * parameter because calendar clients cannot set headers.
   */
  app.get(
    '/feed.ics',
    { schema: { querystring: z.object({ token: z.string() }) } },
    async (req, reply) => {
      const q = req.query
      if (q.token !== env.SERVICE_TOKEN) return reply.code(401).send('unauthorized')

      const from = new Date()
      from.setMonth(from.getMonth() - 3)
      const events = await prisma.calendarEvent.findMany({
        where: { startsAt: { gte: from } },
        include: { project: { select: { key: true } } },
        orderBy: { startsAt: 'asc' },
      })
      reply.header('Content-Type', 'text/calendar; charset=utf-8')
      reply.header('Content-Disposition', 'inline; filename="soloops.ics"')
      return buildIcs(events)
    },
  )

  app.register(async (scope) => {
    // A nested scope does not inherit the type provider, so it asks
    // for it — without this `req.query` in here is `unknown`.
    const secured = scope.withTypeProvider<ZodTypeProvider>()
    secured.addHook('onRequest', app.authenticate)

    secured.get(
      '/',
      {
        schema: {
          querystring: z.object({
            from: z.string().optional(),
            to: z.string().optional(),
            projectId: z.string().optional(),
          }),
        },
      },
      async (req) => {
        const q = req.query

        const from = q.from ? new Date(q.from) : startOfWeek(new Date())
        const to = q.to ? new Date(q.to) : addDays(from, 28)

        return listEventsInRange(from, to, { projectId: q.projectId })
      },
    )

    secured.post('/', { schema: { body: eventInput } }, async (req, reply) => {
      const data = req.body
      const room = data.withVideo ? createVideoRoom(data.title, await videoSettings()) : null
      const created = await prisma.calendarEvent.create({
        data: {
          title: data.title,
          description: data.description ?? null,
          location: data.location ?? null,
          startsAt: new Date(data.startsAt),
          endsAt: new Date(data.endsAt),
          allDay: data.allDay,
          kind: data.kind,
          projectId: data.projectId ?? null,
          clientId: data.clientId ?? null,
          videoUrl: room?.videoUrl ?? data.videoUrl ?? null,
          videoProvider: room?.videoProvider ?? null,
        },
      })
      return reply.code(201).send(created)
    })

    secured.patch(
      '/:id',
      { schema: { params: idParam, body: eventInput.partial() } },
      async (req, reply) => {
        const { id } = req.params
        const data = req.body
        const current = await prisma.calendarEvent.findUniqueOrThrow({ where: { id } })
        if (current.readOnly) {
          return reply
            .code(409)
            .send({ error: 'Serie aus einem Fremdkalender — bitte dort bearbeiten' })
        }

        // Request a video room after the fact
        const room =
          data.withVideo && !current.videoUrl
            ? createVideoRoom(data.title ?? current.title, await videoSettings())
            : null

        return prisma.calendarEvent.update({
          where: { id },
          data: {
            title: data.title,
            description: data.description,
            location: data.location,
            allDay: data.allDay,
            kind: data.kind,
            projectId: data.projectId,
            clientId: data.clientId,
            startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
            endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
            ...(room ? { videoUrl: room.videoUrl, videoProvider: room.videoProvider } : {}),
            ...(data.withVideo === false ? { videoUrl: null, videoProvider: null } : {}),
          },
        })
      },
    )

    secured.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
      const { id } = req.params
      // First note what still has to go from the remote calendars, then delete.
      await tombstoneEvent(id)
      await prisma.calendarEvent.delete({ where: { id } })
      return reply.code(204).send()
    })

    /**
     * The calendars the view tells apart by colour: the local soloops one
     * plus every connected account.
     */
    secured.get('/sources', async () => {
      const accounts = await prisma.calendarAccount.findMany({
        orderBy: [{ provider: 'asc' }, { label: 'asc' }],
        select: {
          id: true,
          label: true,
          provider: true,
          color: true,
          enabled: true,
          remoteCalendarName: true,
        },
      })
      return [
        {
          id: 'local',
          label: 'soloops',
          provider: 'LOCAL' as const,
          color: '#d8ff55',
          enabled: true,
          remoteCalendarName: null,
        },
        ...accounts,
      ]
    })

    /** Change a calendar's colour. */
    secured.patch(
      '/sources/:id/color',
      {
        schema: {
          params: idParam,
          body: z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }),
        },
      },
      async (req, reply) => {
        const { id } = req.params
        const body = req.body
        if (id === 'local') return reply.code(400).send({ error: 'Die lokale Farbe ist fest' })
        return prisma.calendarAccount.update({
          where: { id },
          data: { color: body.color },
          select: { id: true, color: true },
        })
      },
    )

    /**
     * Find free slots inside working hours — the basis for "when does a
     * meeting fit" and for the MCP tool of the same name.
     */
    secured.get(
      '/free-slots',
      {
        schema: {
          querystring: z.object({
            from: z.string().optional(),
            days: z.coerce.number().min(1).max(60).default(10),
            minMinutes: z.coerce.number().min(15).default(60),
            dayStart: z.coerce.number().min(0).max(23).default(9),
            dayEnd: z.coerce.number().min(1).max(24).default(18),
          }),
        },
      },
      async (req) => {
        const q = req.query

        const from = q.from ? new Date(q.from) : new Date()
        const to = addDays(from, q.days)
        const events = await prisma.calendarEvent.findMany({
          where: { startsAt: { lt: to }, endsAt: { gt: from } },
          orderBy: { startsAt: 'asc' },
        })

        const slots: { start: string; end: string; minutes: number }[] = []
        for (let d = 0; d < q.days; d++) {
          const day = addDays(from, d)
          if (day.getDay() === 0 || day.getDay() === 6) continue
          let cursor = new Date(day)
          cursor.setHours(q.dayStart, 0, 0, 0)
          const dayEnd = new Date(day)
          dayEnd.setHours(q.dayEnd, 0, 0, 0)
          if (cursor < from) cursor = new Date(Math.ceil(from.getTime() / 900000) * 900000)

          const busy = events
            .filter((e) => e.endsAt > cursor && e.startsAt < dayEnd)
            .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())

          for (const e of busy) {
            if (e.startsAt.getTime() - cursor.getTime() >= q.minMinutes * 60000) {
              slots.push({
                start: cursor.toISOString(),
                end: e.startsAt.toISOString(),
                minutes: Math.round((e.startsAt.getTime() - cursor.getTime()) / 60000),
              })
            }
            if (e.endsAt > cursor) cursor = new Date(e.endsAt)
          }
          if (dayEnd.getTime() - cursor.getTime() >= q.minMinutes * 60000) {
            slots.push({
              start: cursor.toISOString(),
              end: dayEnd.toISOString(),
              minutes: Math.round((dayEnd.getTime() - cursor.getTime()) / 60000),
            })
          }
        }
        return slots
      },
    )
  })
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + n)
  return copy
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d)
  const day = (copy.getDay() + 6) % 7 // Monday = 0
  copy.setDate(copy.getDate() - day)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export default routes
