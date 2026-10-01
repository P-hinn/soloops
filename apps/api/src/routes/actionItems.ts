import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'

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
    return prisma.actionItem.update({ where: { id }, data })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await prisma.actionItem.delete({ where: { id } })
    return reply.code(204).send()
  })
}

export default routes
