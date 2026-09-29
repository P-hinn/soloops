import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { uptimeQueue } from '../queue.js'
import { syncUptimeRobot } from '../services/uptimerobot.js'

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async () => {
    const monitors = await prisma.monitor.findMany({
      orderBy: [{ status: 'desc' }, { friendlyName: 'asc' }],
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        incidents: { orderBy: { startedAt: 'desc' }, take: 3 },
      },
    })
    return {
      configured: !!env.UPTIMEROBOT_API_KEY,
      down: monitors.filter((m) => m.status === 8 || m.status === 9).length,
      monitors,
    }
  })

  app.get('/incidents', async (req) => {
    const q = z.object({ take: z.coerce.number().max(200).default(50) }).parse(req.query)
    return prisma.incident.findMany({
      orderBy: { startedAt: 'desc' },
      take: q.take,
      include: { monitor: { select: { friendlyName: true, url: true, projectId: true } } },
    })
  })

  /** Sync right now (otherwise the worker does it on a schedule). */
  app.post('/sync', async (_req, reply) => {
    if (!env.UPTIMEROBOT_API_KEY) {
      return reply.code(503).send({ error: 'UPTIMEROBOT_API_KEY nicht gesetzt' })
    }
    return syncUptimeRobot()
  })

  app.post('/sync/queue', async () => {
    await uptimeQueue.add('sync', {}, { removeOnComplete: 20 })
    return { queued: true }
  })

  /** Assign a monitor to a project — connects operations to the project view. */
  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z.object({ projectId: z.string().nullable() }).parse(req.body)
    return prisma.monitor.update({ where: { id }, data: { projectId: body.projectId } })
  })
}

export default routes
