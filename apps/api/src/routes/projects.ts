import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { projectInput, ProjectStatus } from '@soloops/shared'
import { prisma } from '../db.js'
import { digestQueue } from '../queue.js'
import { buildProjectDigest } from '../ai/digest.js'
import { env } from '../env.js'

const idParam = z.object({ id: z.string() })

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z.object({ status: ProjectStatus.optional() }).parse(req.query)
    const projects = await prisma.project.findMany({
      where: q.status ? { status: q.status } : { status: { not: 'ARCHIVED' } },
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      include: {
        client: { select: { id: true, name: true, company: true } },
        _count: { select: { timeEntries: true, notes_: true, meetings: true } },
      },
    })

    // Aggregierte Zeit pro Projekt in einem Rutsch
    const totals = await prisma.timeEntry.groupBy({
      by: ['projectId'],
      _sum: { durationSec: true },
    })
    const unbilled = await prisma.timeEntry.groupBy({
      by: ['projectId'],
      where: { billable: true, invoiceItemId: null, endedAt: { not: null } },
      _sum: { durationSec: true },
    })
    const totalMap = new Map(totals.map((t) => [t.projectId, t._sum.durationSec ?? 0]))
    const unbilledMap = new Map(unbilled.map((t) => [t.projectId, t._sum.durationSec ?? 0]))

    return projects.map((p) => ({
      ...p,
      trackedSec: totalMap.get(p.id) ?? 0,
      unbilledSec: unbilledMap.get(p.id) ?? 0,
    }))
  })

  app.get('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        client: true,
        monitors: true,
        repos: { include: { runs: { orderBy: { startedAt: 'desc' }, take: 5 } } },
        notes_: { orderBy: { updatedAt: 'desc' }, take: 10 },
        meetings: { orderBy: { startsAt: 'desc' }, take: 10 },
        actionItems: { where: { done: false }, orderBy: { dueOn: 'asc' } },
        digests: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    })
    if (!project) return reply.code(404).send({ error: 'Projekt nicht gefunden' })

    const [tracked, unbilled, invoiced] = await Promise.all([
      prisma.timeEntry.aggregate({ where: { projectId: id }, _sum: { durationSec: true } }),
      prisma.timeEntry.aggregate({
        where: { projectId: id, billable: true, invoiceItemId: null, endedAt: { not: null } },
        _sum: { durationSec: true },
      }),
      prisma.invoice.aggregate({
        where: { projectId: id, status: { in: ['SENT', 'PAID', 'OVERDUE'] } },
        _sum: { totalCents: true },
      }),
    ])

    return {
      ...project,
      trackedSec: tracked._sum.durationSec ?? 0,
      unbilledSec: unbilled._sum.durationSec ?? 0,
      invoicedCents: invoiced._sum.totalCents ?? 0,
    }
  })

  app.post('/', async (req, reply) => {
    const data = projectInput.parse(req.body)
    const created = await prisma.project.create({
      data: {
        ...data,
        startsOn: data.startsOn ? new Date(data.startsOn) : null,
        dueOn: data.dueOn ? new Date(data.dueOn) : null,
      },
    })
    return reply.code(201).send(created)
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = projectInput.partial().parse(req.body)
    return prisma.project.update({
      where: { id },
      data: {
        ...data,
        startsOn: data.startsOn ? new Date(data.startsOn) : undefined,
        dueOn: data.dueOn ? new Date(data.dueOn) : undefined,
      },
    })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await prisma.project.update({ where: { id }, data: { status: 'ARCHIVED' } })
    return reply.code(204).send()
  })

  // --- AI ------------------------------------------------------------------

  /** Digest sofort erzeugen (synchron, damit die UI direkt etwas zeigt). */
  app.post('/:id/digest', async (req, reply) => {
    if (!env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY nicht gesetzt' })
    }
    const { id } = idParam.parse(req.params)
    return buildProjectDigest(id)
  })

  /** Digests für alle aktiven Projekte im Hintergrund neu bauen. */
  app.post('/digest/all', async () => {
    await digestQueue.add('all-projects', { kind: 'project' }, { removeOnComplete: 50 })
    return { queued: true }
  })

  app.get('/:id/digests', async (req) => {
    const { id } = idParam.parse(req.params)
    return prisma.aiDigest.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
  })
}

export default routes
