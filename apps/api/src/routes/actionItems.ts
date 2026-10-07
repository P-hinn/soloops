import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { emitAutomationEvent } from '../services/automationDelivery.js'

/**
 * Action items on their own.
 *
 * Until now they could only come into being inside a meeting and never be
 * ticked off again. A to-do that cannot be closed is not a to-do, so here is
 * the plain list plus create, change and delete.
 */

const idParam = z.object({ id: z.string() })

/**
 * `z.coerce.boolean()` would read "false" as true — every non-empty string is
 * truthy. Query parameters therefore go through this instead.
 */
const boolParam = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const itemInput = z.object({
  title: z.string().min(1),
  done: z.boolean().optional(),
  dueOn: z.coerce.date().nullish(),
  assignee: z.string().nullish(),
  projectId: z.string().nullish(),
  meetingId: z.string().nullish(),
  source: z.enum(['MANUAL', 'AI', 'MCP']).default('MANUAL'),
})

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({
        open: boolParam.default('true'),
        projectId: z.string().optional(),
        meetingId: z.string().optional(),
        take: z.coerce.number().max(200).default(100),
      })
      .parse(req.query)

    return prisma.actionItem.findMany({
      where: {
        ...(q.open ? { done: false } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.meetingId ? { meetingId: q.meetingId } : {}),
      },
      orderBy: [{ done: 'asc' }, { dueOn: 'asc' }, { createdAt: 'asc' }],
      take: q.take,
      include: {
        project: { select: { id: true, key: true, name: true } },
        meeting: { select: { id: true, title: true } },
      },
    })
  })

  app.post('/', async (req, reply) => {
    const data = itemInput.parse(req.body)
    // An item hanging off a meeting belongs to that meeting's project too.
    const meeting = data.meetingId
      ? await prisma.meeting.findUniqueOrThrow({ where: { id: data.meetingId } })
      : null
    const created = await prisma.actionItem.create({
      data: { ...data, projectId: data.projectId ?? meeting?.projectId ?? null },
    })
    return reply.code(201).send(created)
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = itemInput.partial().parse(req.body)
    // The previous state decides whether this is an event: ticking an item
    // that was already done is a no-op, and a workflow should not see it.
    const before = await prisma.actionItem.findUniqueOrThrow({
      where: { id },
      select: { done: true },
    })
    const updated = await prisma.actionItem.update({ where: { id }, data })

    if (!before.done && updated.done) {
      await emitAutomationEvent({
        event: 'TASK_COMPLETED',
        projectId: updated.projectId,
        path: updated.projectId ? `/projects/${updated.projectId}` : null,
        data: {
          id: updated.id,
          title: updated.title,
          assignee: updated.assignee,
          dueOn: updated.dueOn,
          projectId: updated.projectId,
          meetingId: updated.meetingId,
        },
      })
    }
    return updated
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await prisma.actionItem.delete({ where: { id } })
    return reply.code(204).send()
  })
}

export default routes
