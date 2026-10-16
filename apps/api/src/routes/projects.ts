import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { serviceKeys } from '@soloops/core/settings.js'
import { z } from 'zod'
import { ProjectStatus, idParam, projectInput } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { digestQueue } from '@soloops/core/queue.js'
import { buildProjectDigest } from '@soloops/core/ai/digest.js'
import { emitAutomationEvent } from '@soloops/core/services/automationDelivery.js'

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get(
    '/',
    { schema: { querystring: z.object({ status: ProjectStatus.optional() }) } },
    async (req) => {
      const q = req.query
      const projects = await prisma.project.findMany({
        where: q.status ? { status: q.status } : { status: { not: 'ARCHIVED' } },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        include: {
          client: { select: { id: true, name: true, company: true } },
          _count: { select: { timeEntries: true, notes_: true, meetings: true } },
        },
      })

      // Aggregated time per project in one query
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
    },
  )

  app.get('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
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

  app.post('/', { schema: { body: projectInput } }, async (req, reply) => {
    const data = req.body
    const created = await prisma.project.create({
      data: {
        ...data,
        startsOn: data.startsOn ? new Date(data.startsOn) : null,
        dueOn: data.dueOn ? new Date(data.dueOn) : null,
      },
    })
    await emitAutomationEvent({
      event: 'PROJECT_CREATED',
      projectId: created.id,
      path: `/projects/${created.id}`,
      data: {
        id: created.id,
        key: created.key,
        name: created.name,
        status: created.status,
        clientId: created.clientId,
        dueOn: created.dueOn,
      },
    })
    return reply.code(201).send(created)
  })

  app.patch('/:id', { schema: { params: idParam, body: projectInput.partial() } }, async (req) => {
    const { id } = req.params
    const data = req.body
    return prisma.project.update({
      where: { id },
      data: {
        ...data,
        startsOn: data.startsOn ? new Date(data.startsOn) : undefined,
        dueOn: data.dueOn ? new Date(data.dueOn) : undefined,
      },
    })
  })

  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    await prisma.project.update({ where: { id }, data: { status: 'ARCHIVED' } })
    return reply.code(204).send()
  })

  // --- AI ------------------------------------------------------------------

  /** Build a digest right now (synchronously, so the UI has something). */
  app.post('/:id/digest', { schema: { params: idParam } }, async (req, reply) => {
    const keys = await serviceKeys()
    if (!keys.anthropic) {
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY nicht gesetzt' })
    }
    const { id } = req.params
    return buildProjectDigest(id)
  })

  /** Rebuild the digests of all active projects in the background. */
  app.post('/digest/all', async () => {
    await digestQueue.add('all-projects', { kind: 'project' }, { removeOnComplete: 50 })
    return { queued: true }
  })

  app.get('/:id/digests', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return prisma.aiDigest.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    })
  })
}

export default routes
