import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { eventInput } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { buildIcs } from '../services/ics.js'
import { tombstoneEvent } from '../services/calendarSync.js'
import { createVideoRoom } from '../services/video.js'

const idParam = z.object({ id: z.string() })

const routes: FastifyPluginAsync = async (app) => {
  /**
   * ICS-Feed für Apple/Google Kalender. Nutzt den SERVICE_TOKEN als Query-Param,
   * weil Kalender-Clients keine Header setzen können.
   */
  app.get('/feed.ics', async (req, reply) => {
    const q = z.object({ token: z.string() }).parse(req.query)
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
  })

  app.register(async (secured) => {
    secured.addHook('onRequest', app.authenticate)

    secured.get('/', async (req) => {
      const q = z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
          projectId: z.string().optional(),
        })
        .parse(req.query)

      const from = q.from ? new Date(q.from) : startOfWeek(new Date())
      const to = q.to ? new Date(q.to) : addDays(from, 28)

      return prisma.calendarEvent.findMany({
        where: {
          startsAt: { lt: to },
          endsAt: { gt: from },
          ...(q.projectId ? { projectId: q.projectId } : {}),
        },
        include: {
          project: { select: { id: true, key: true, name: true, color: true } },
          client: { select: { id: true, name: true } },
          meeting: { select: { id: true, status: true } },
          // Über welchen Kalender kam der Termin? Trägt die Farbgebung.
          links: { select: { accountId: true } },
        },
        orderBy: { startsAt: 'asc' },
      })
    })

    secured.post('/', async (req, reply) => {
      const data = eventInput.parse(req.body)
      const room = data.withVideo ? createVideoRoom(data.title) : null
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

    secured.patch('/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params)
      const data = eventInput.partial().parse(req.body)
      const current = await prisma.calendarEvent.findUniqueOrThrow({ where: { id } })
      if (current.readOnly) {
        return reply
          .code(409)
          .send({ error: 'Serie aus einem Fremdkalender — bitte dort bearbeiten' })
      }

      // Videoraum nachträglich anfordern
      const room =
        data.withVideo && !current.videoUrl ? createVideoRoom(data.title ?? current.title) : null

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
    })

    secured.delete('/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params)
      // Erst merken, was in den Fremdkalendern noch wegmuss — danach löschen.
      await tombstoneEvent(id)
      await prisma.calendarEvent.delete({ where: { id } })
      return reply.code(204).send()
    })

    /**
     * Die Kalender, zwischen denen die Ansicht farblich unterscheidet:
     * das lokale soloops plus jedes verbundene Konto.
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

    /** Farbe eines Kalenders ändern. */
    secured.patch('/sources/:id/color', async (req, reply) => {
      const { id } = idParam.parse(req.params)
      const body = z.object({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).parse(req.body)
      if (id === 'local') return reply.code(400).send({ error: 'Die lokale Farbe ist fest' })
      return prisma.calendarAccount.update({
        where: { id },
        data: { color: body.color },
        select: { id: true, color: true },
      })
    })

    /**
     * Freie Slots im Arbeitszeitfenster finden — Basis für "wann passt ein
     * Termin rein" und für das gleichnamige MCP-Tool.
     */
    secured.get('/free-slots', async (req) => {
      const q = z
        .object({
          from: z.string().optional(),
          days: z.coerce.number().min(1).max(60).default(10),
          minMinutes: z.coerce.number().min(15).default(60),
          dayStart: z.coerce.number().min(0).max(23).default(9),
          dayEnd: z.coerce.number().min(1).max(24).default(18),
        })
        .parse(req.query)

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
    })
  })
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d)
  copy.setDate(copy.getDate() + n)
  return copy
}

function startOfWeek(d: Date): Date {
  const copy = new Date(d)
  const day = (copy.getDay() + 6) % 7 // Montag = 0
  copy.setDate(copy.getDate() - day)
  copy.setHours(0, 0, 0, 0)
  return copy
}

export default routes
