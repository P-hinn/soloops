import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { planFromText } from '../ai/assistant.js'
import { createVideoRoom } from '../services/video.js'

/**
 * Two endpoints, deliberately separate:
 *   POST /plan   — interprets the sentence, creates nothing
 *   POST /apply  — creates what the (possibly corrected) plan says
 *
 * `apply` does not trust the plan blindly: every id is checked against the
 * database, keys are tested for collisions, times are validated.
 */

const planInput = z.object({ text: z.string().min(3).max(2000) })

const applyInput = z.object({
  client: z.object({
    action: z.enum(['use', 'create', 'none']),
    id: z.string().nullish(),
    name: z.string().nullish(),
    company: z.string().nullish(),
    email: z.string().nullish(),
  }),
  project: z.object({
    action: z.enum(['use', 'create', 'none']),
    id: z.string().nullish(),
    name: z.string().nullish(),
    key: z.string().nullish(),
    description: z.string().nullish(),
  }),
  event: z.object({
    create: z.boolean(),
    title: z.string().nullish(),
    startsAt: z.string().nullish(),
    endsAt: z.string().nullish(),
    kind: z.enum(['FOCUS', 'MEETING', 'ADMIN', 'PERSONAL', 'TRAVEL']).default('FOCUS'),
    location: z.string().nullish(),
    withVideo: z.boolean().default(false),
  }),
  meeting: z.object({
    create: z.boolean(),
    title: z.string().nullish(),
    participants: z.array(z.string()).default([]),
    agenda: z.string().nullish(),
  }),
  note: z.object({
    create: z.boolean(),
    title: z.string().nullish(),
    body: z.string().nullish(),
    tags: z.array(z.string()).default([]),
  }),
  actionItems: z.array(z.object({ title: z.string(), dueOn: z.string().nullish() })).default([]),
  timer: z.object({ start: z.boolean(), description: z.string().nullish() }),
})

/** Find a free project key: ACME-DWH, ACME-DWH-2, … */
async function freeProjectKey(wanted: string): Promise<string> {
  const base =
    wanted
      .toUpperCase()
      .replace(/[^A-Z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 20) || 'PROJEKT'
  let key = base
  for (let i = 2; await prisma.project.findUnique({ where: { key } }); i++) {
    key = `${base}-${i}`.slice(0, 24)
  }
  return key
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.post('/plan', async (req, reply) => {
    if (!env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY nicht gesetzt' })
    }
    const { text } = planInput.parse(req.body)
    return planFromText(text)
  })

  app.post('/apply', async (req, reply) => {
    const plan = applyInput.parse(req.body)

    const created: {
      clientId?: string
      projectId?: string
      eventId?: string
      meetingId?: string
      noteId?: string
      timeEntryId?: string
      actionItemIds: string[]
      videoUrl?: string
      links: { label: string; url: string }[]
    } = { actionItemIds: [], links: [] }

    // --- Client ------------------------------------------------------------
    let clientId: string | null = null
    if (plan.client.action === 'use' && plan.client.id) {
      const found = await prisma.client.findUnique({ where: { id: plan.client.id } })
      if (!found) return reply.code(422).send({ error: 'Kunde existiert nicht mehr' })
      clientId = found.id
    } else if (plan.client.action === 'create' && plan.client.name) {
      const client = await prisma.client.create({
        data: {
          name: plan.client.name,
          company: plan.client.company ?? null,
          email: plan.client.email ?? null,
          hourlyRateCents: env.INVOICE_DEFAULT_HOURLY_RATE_CENTS,
          paymentTermDays: env.INVOICE_PAYMENT_TERM_DAYS,
        },
      })
      clientId = client.id
      created.clientId = client.id
      created.links.push({ label: `Kunde ${client.name}`, url: '/clients' })
    }

    // --- Project -----------------------------------------------------------
    let projectId: string | null = null
    if (plan.project.action === 'use' && plan.project.id) {
      const found = await prisma.project.findUnique({ where: { id: plan.project.id } })
      if (!found) return reply.code(422).send({ error: 'Projekt existiert nicht mehr' })
      projectId = found.id
      if (!clientId) clientId = found.clientId
    } else if (plan.project.action === 'create' && plan.project.name) {
      const project = await prisma.project.create({
        data: {
          key: await freeProjectKey(plan.project.key ?? plan.project.name),
          name: plan.project.name,
          description: plan.project.description ?? null,
          clientId,
          status: 'ACTIVE',
        },
      })
      projectId = project.id
      created.projectId = project.id
      created.links.push({ label: `Projekt ${project.key}`, url: `/projects/${project.id}` })
    }

    // --- Event -------------------------------------------------------------
    let eventId: string | null = null
    let videoUrl: string | null = null
    if (plan.event.create && plan.event.startsAt) {
      const startsAt = new Date(plan.event.startsAt)
      const endsAt = plan.event.endsAt
        ? new Date(plan.event.endsAt)
        : new Date(startsAt.getTime() + 3_600_000)
      if (Number.isNaN(startsAt.getTime()) || endsAt <= startsAt) {
        return reply.code(422).send({ error: 'Termin hat keine gültige Zeitspanne' })
      }

      const title = plan.event.title ?? plan.meeting.title ?? 'Termin'
      const room = plan.event.withVideo ? createVideoRoom(title) : null
      videoUrl = room?.videoUrl ?? null

      const event = await prisma.calendarEvent.create({
        data: {
          title,
          startsAt,
          endsAt,
          kind: plan.event.kind,
          location: plan.event.location ?? null,
          projectId,
          clientId,
          videoUrl: room?.videoUrl ?? null,
          videoProvider: room?.videoProvider ?? null,
        },
      })
      eventId = event.id
      created.eventId = event.id
      if (videoUrl) created.videoUrl = videoUrl
      created.links.push({ label: 'Termin im Kalender', url: '/calendar' })
    }

    // --- Meeting -----------------------------------------------------------
    if (plan.meeting.create) {
      const startsAt = plan.event.startsAt ? new Date(plan.event.startsAt) : new Date()
      const endsAt = plan.event.endsAt
        ? new Date(plan.event.endsAt)
        : new Date(startsAt.getTime() + 3_600_000)

      const meeting = await prisma.meeting.create({
        data: {
          title: plan.meeting.title ?? plan.event.title ?? 'Meeting',
          startsAt,
          endsAt,
          participants: plan.meeting.participants,
          agenda: plan.meeting.agenda ?? null,
          projectId,
          clientId,
          eventId,
          videoUrl,
          videoProvider: videoUrl ? 'JITSI' : null,
        },
      })
      created.meetingId = meeting.id
      created.links.push({ label: 'Meeting', url: `/meetings/${meeting.id}` })
    }

    // --- Note --------------------------------------------------------------
    if (plan.note.create && plan.note.title) {
      const note = await prisma.note.create({
        data: {
          title: plan.note.title,
          body: plan.note.body ?? '',
          tags: plan.note.tags,
          projectId,
          clientId,
        },
      })
      created.noteId = note.id
      created.links.push({ label: 'Notiz', url: '/notes' })
    }

    // --- Action items ------------------------------------------------------
    for (const item of plan.actionItems) {
      const action = await prisma.actionItem.create({
        data: {
          title: item.title,
          dueOn: item.dueOn ? new Date(item.dueOn) : null,
          projectId,
          meetingId: created.meetingId ?? null,
          source: 'AI',
        },
      })
      created.actionItemIds.push(action.id)
    }

    // --- Timer -------------------------------------------------------------
    if (plan.timer.start && projectId) {
      const running = await prisma.timeEntry.findFirst({ where: { endedAt: null } })
      if (running) {
        const endedAt = new Date()
        await prisma.timeEntry.update({
          where: { id: running.id },
          data: {
            endedAt,
            durationSec: Math.round((endedAt.getTime() - running.startedAt.getTime()) / 1000),
          },
        })
      }
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        include: { client: true },
      })
      const entry = await prisma.timeEntry.create({
        data: {
          projectId,
          clientId: project.clientId,
          description: plan.timer.description ?? '',
          startedAt: new Date(),
          source: 'MCP',
          rateCents:
            project.hourlyRateCents ??
            project.client?.hourlyRateCents ??
            env.INVOICE_DEFAULT_HOURLY_RATE_CENTS,
        },
      })
      created.timeEntryId = entry.id
      created.links.push({ label: 'Timer läuft', url: '/time' })
    }

    return reply.code(201).send(created)
  })
}

export default routes
