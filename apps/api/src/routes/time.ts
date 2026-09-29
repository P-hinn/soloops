import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { timeEntryInput, timerStartInput } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'

const idParam = z.object({ id: z.string() })

/** Hourly rate: project > client > global default. */
async function resolveRateCents(projectId: string): Promise<number> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { client: true },
  })
  return (
    project.hourlyRateCents ??
    project.client?.hourlyRateCents ??
    env.INVOICE_DEFAULT_HOURLY_RATE_CENTS
  )
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  /** The running timer (endedAt === null). There is never more than one. */
  app.get('/running', async () => {
    return prisma.timeEntry.findFirst({
      where: { endedAt: null },
      include: { project: { select: { id: true, key: true, name: true, color: true } } },
      orderBy: { startedAt: 'desc' },
    })
  })

  app.post('/start', async (req, reply) => {
    const data = timerStartInput.parse(req.body)

    // Stop a running timer automatically — no double tracking.
    const running = await prisma.timeEntry.findFirst({ where: { endedAt: null } })
    if (running) await stopEntry(running.id)

    const project = await prisma.project.findUniqueOrThrow({ where: { id: data.projectId } })
    const entry = await prisma.timeEntry.create({
      data: {
        projectId: data.projectId,
        clientId: project.clientId,
        description: data.description,
        billable: data.billable,
        tags: data.tags,
        source: data.source,
        startedAt: new Date(),
        rateCents: await resolveRateCents(data.projectId),
      },
      include: { project: { select: { id: true, key: true, name: true, color: true } } },
    })
    return reply.code(201).send(entry)
  })

  app.post('/stop', async (req, reply) => {
    const body = z.object({ id: z.string().optional() }).parse(req.body ?? {})
    const running = body.id
      ? await prisma.timeEntry.findUnique({ where: { id: body.id } })
      : await prisma.timeEntry.findFirst({ where: { endedAt: null } })
    if (!running) return reply.code(404).send({ error: 'Kein laufender Timer' })
    return stopEntry(running.id)
  })

  app.get('/', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        clientId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        billable: z.coerce.boolean().optional(),
        unbilledOnly: z.coerce.boolean().default(false),
        take: z.coerce.number().max(500).default(200),
      })
      .parse(req.query)

    return prisma.timeEntry.findMany({
      where: {
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(q.billable !== undefined ? { billable: q.billable } : {}),
        ...(q.unbilledOnly ? { invoiceItemId: null, billable: true, endedAt: { not: null } } : {}),
        ...(q.from || q.to
          ? {
              startedAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to ? { lte: new Date(q.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: q.take,
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        client: { select: { id: true, name: true } },
      },
    })
  })

  app.post('/', async (req, reply) => {
    const data = timeEntryInput.parse(req.body)
    const startedAt = new Date(data.startedAt)
    const endedAt = new Date(data.endedAt)
    if (endedAt <= startedAt)
      return reply.code(422).send({ error: 'Ende muss nach dem Start liegen' })

    const project = await prisma.project.findUniqueOrThrow({ where: { id: data.projectId } })
    const entry = await prisma.timeEntry.create({
      data: {
        projectId: data.projectId,
        clientId: project.clientId,
        description: data.description,
        startedAt,
        endedAt,
        durationSec: Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
        billable: data.billable,
        tags: data.tags,
        source: 'MANUAL',
        rateCents: data.rateCents ?? (await resolveRateCents(data.projectId)),
      },
    })
    return reply.code(201).send(entry)
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = timeEntryInput.partial().parse(req.body)
    const current = await prisma.timeEntry.findUniqueOrThrow({ where: { id } })
    const startedAt = data.startedAt ? new Date(data.startedAt) : current.startedAt
    const endedAt = data.endedAt ? new Date(data.endedAt) : current.endedAt
    return prisma.timeEntry.update({
      where: { id },
      data: {
        description: data.description,
        billable: data.billable,
        tags: data.tags,
        rateCents: data.rateCents,
        projectId: data.projectId,
        startedAt,
        endedAt,
        durationSec: endedAt ? Math.round((endedAt.getTime() - startedAt.getTime()) / 1000) : 0,
      },
    })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id } })
    if (entry.invoiceItemId) {
      return reply.code(409).send({ error: 'Eintrag ist bereits abgerechnet' })
    }
    await prisma.timeEntry.delete({ where: { id } })
    return reply.code(204).send()
  })

  /** Weekly/monthly report, grouped by project. */
  app.get('/report', async (req) => {
    const q = z
      .object({ from: z.string(), to: z.string(), billableOnly: z.coerce.boolean().default(false) })
      .parse(req.query)

    const grouped = await prisma.timeEntry.groupBy({
      by: ['projectId'],
      where: {
        startedAt: { gte: new Date(q.from), lte: new Date(q.to) },
        endedAt: { not: null },
        ...(q.billableOnly ? { billable: true } : {}),
      },
      _sum: { durationSec: true },
      _count: true,
    })

    const projects = await prisma.project.findMany({
      where: { id: { in: grouped.map((g) => g.projectId) } },
      include: { client: { select: { name: true } } },
    })

    const rows = grouped.map((g) => {
      const project = projects.find((p) => p.id === g.projectId)
      const seconds = g._sum.durationSec ?? 0
      const rate = project?.hourlyRateCents ?? env.INVOICE_DEFAULT_HOURLY_RATE_CENTS
      return {
        projectId: g.projectId,
        projectKey: project?.key ?? '?',
        projectName: project?.name ?? 'Unbekannt',
        clientName: project?.client?.name ?? null,
        entries: g._count,
        seconds,
        hours: Math.round((seconds / 3600) * 100) / 100,
        valueCents: Math.round((seconds / 3600) * rate),
      }
    })

    return {
      from: q.from,
      to: q.to,
      totalSeconds: rows.reduce((s, r) => s + r.seconds, 0),
      totalValueCents: rows.reduce((s, r) => s + r.valueCents, 0),
      rows: rows.sort((a, b) => b.seconds - a.seconds),
    }
  })
}

async function stopEntry(id: string) {
  const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id } })
  if (entry.endedAt) return entry
  const endedAt = new Date()
  return prisma.timeEntry.update({
    where: { id },
    data: {
      endedAt,
      durationSec: Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 1000),
    },
    include: { project: { select: { id: true, key: true, name: true, color: true } } },
  })
}

export default routes
