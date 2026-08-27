import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { meetingInput } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { summarizeMeeting } from '../ai/digest.js'
import { createVideoRoom } from '../services/video.js'
import { tombstoneEvent } from '../services/calendarSync.js'

const idParam = z.object({ id: z.string() })

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        from: z.string().optional(),
        take: z.coerce.number().max(200).default(50),
      })
      .parse(req.query)

    return prisma.meeting.findMany({
      where: {
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.from ? { startsAt: { gte: new Date(q.from) } } : {}),
      },
      orderBy: { startsAt: 'desc' },
      take: q.take,
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        client: { select: { id: true, name: true } },
        _count: { select: { actionItems: true } },
      },
    })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: {
        project: true,
        client: true,
        actionItems: { orderBy: [{ done: 'asc' }, { createdAt: 'asc' }] },
        notes_: true,
      },
    })
    if (!meeting) return reply.code(404).send({ error: 'Meeting nicht gefunden' })
    return meeting
  })

  app.post('/', async (req, reply) => {
    const data = meetingInput.parse(req.body)
    const startsAt = new Date(data.startsAt)
    const endsAt = data.endsAt ? new Date(data.endsAt) : new Date(startsAt.getTime() + 3600_000)

    // Videoraum einmal erzeugen und in Termin und Meeting spiegeln
    const room = data.withVideo
      ? createVideoRoom(data.title)
      : data.videoUrl
        ? { videoUrl: data.videoUrl, videoProvider: 'CUSTOM' as const }
        : null

    // Kalendereintrag zuerst, damit Meeting und Termin dieselbe Zeit teilen.
    const event = data.createEvent
      ? await prisma.calendarEvent.create({
          data: {
            title: data.title,
            startsAt,
            endsAt,
            kind: 'MEETING',
            projectId: data.projectId ?? null,
            clientId: data.clientId ?? null,
            videoUrl: room?.videoUrl ?? null,
            videoProvider: room?.videoProvider ?? null,
          },
        })
      : null

    const meeting = await prisma.meeting.create({
      data: {
        title: data.title,
        status: data.status,
        startsAt,
        endsAt,
        participants: data.participants,
        agenda: data.agenda ?? null,
        minutes: data.minutes ?? null,
        projectId: data.projectId ?? null,
        clientId: data.clientId ?? null,
        eventId: event?.id ?? null,
        videoUrl: room?.videoUrl ?? null,
        videoProvider: room?.videoProvider ?? null,
      },
      include: { event: true },
    })
    return reply.code(201).send(meeting)
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = meetingInput.partial().parse(req.body)
    const meeting = await prisma.meeting.update({
      where: { id },
      data: {
        title: data.title,
        status: data.status,
        startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
        endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
        participants: data.participants,
        agenda: data.agenda,
        minutes: data.minutes,
        projectId: data.projectId,
        clientId: data.clientId,
      },
      include: { event: true },
    })
    // Verknüpften Kalendereintrag mitziehen
    if (meeting.eventId && (data.title || data.startsAt || data.endsAt)) {
      await prisma.calendarEvent.update({
        where: { id: meeting.eventId },
        data: {
          title: data.title,
          startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
          endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
        },
      })
    }
    return meeting
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id } })
    await prisma.meeting.delete({ where: { id } })
    // Der Kalendereintrag gehört zum Meeting — mit weg, auch in den Fremdkalendern.
    if (meeting.eventId) {
      await tombstoneEvent(meeting.eventId)
      await prisma.calendarEvent.delete({ where: { id: meeting.eventId } }).catch(() => {})
    }
    return reply.code(204).send()
  })

  /** Videoraum nachträglich anlegen oder ersetzen. */
  app.post('/:id/video', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ url: z.string().url().optional() }).parse(req.body ?? {})
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id } })

    const room = body.url
      ? { videoUrl: body.url, videoProvider: 'CUSTOM' as const }
      : createVideoRoom(meeting.title)
    if (!room) return { error: 'Kein Videoanbieter konfiguriert' }

    const updated = await prisma.meeting.update({
      where: { id },
      data: { videoUrl: room.videoUrl, videoProvider: room.videoProvider },
    })
    if (meeting.eventId) {
      await prisma.calendarEvent.update({
        where: { id: meeting.eventId },
        data: { videoUrl: room.videoUrl, videoProvider: room.videoProvider },
      })
    }
    return updated
  })

  /** AI-Zusammenfassung + Action Items aus der Mitschrift. */
  app.post('/:id/summarize', async (req, reply) => {
    if (!env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY nicht gesetzt' })
    const { id } = idParam.parse(req.params)
    return summarizeMeeting(id)
  })

  // --- Action Items --------------------------------------------------------

  app.post('/:id/action-items', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        title: z.string().min(1),
        dueOn: z.string().nullish(),
        assignee: z.string().nullish(),
      })
      .parse(req.body)
    const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id } })
    const item = await prisma.actionItem.create({
      data: {
        title: body.title,
        dueOn: body.dueOn ? new Date(body.dueOn) : null,
        assignee: body.assignee ?? null,
        meetingId: id,
        projectId: meeting.projectId,
      },
    })
    return reply.code(201).send(item)
  })
}

export default routes
