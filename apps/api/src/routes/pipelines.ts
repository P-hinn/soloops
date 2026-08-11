import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { repoInput } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { pipelineQueue } from '../queue.js'
import { syncRepo } from '../services/pipelines.js'

const idParam = z.object({ id: z.string() })

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/repos', async () => {
    const repos = await prisma.pipelineRepo.findMany({
      orderBy: { slug: 'asc' },
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 8 },
      },
    })
    return {
      configured: { github: !!env.GITHUB_TOKEN, gitlab: !!env.GITLAB_TOKEN },
      repos,
    }
  })

  app.post('/repos', async (req, reply) => {
    const data = repoInput.parse(req.body)
    const repo = await prisma.pipelineRepo.upsert({
      where: { provider_slug: { provider: data.provider, slug: data.slug } },
      create: data,
      update: { branch: data.branch, projectId: data.projectId ?? null, enabled: data.enabled },
    })
    await pipelineQueue.add('sync-repo', { repoId: repo.id }, { removeOnComplete: 20 })
    return reply.code(201).send(repo)
  })

  app.patch('/repos/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = repoInput.partial().parse(req.body)
    return prisma.pipelineRepo.update({ where: { id }, data })
  })

  app.delete('/repos/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await prisma.pipelineRepo.delete({ where: { id } })
    return reply.code(204).send()
  })

  app.post('/repos/:id/sync', async (req) => {
    const { id } = idParam.parse(req.params)
    return syncRepo(id)
  })

  app.get('/runs', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        status: z.string().optional(),
        take: z.coerce.number().max(200).default(50),
      })
      .parse(req.query)

    return prisma.pipelineRun.findMany({
      where: {
        ...(q.projectId ? { repo: { projectId: q.projectId } } : {}),
        ...(q.status ? { status: q.status as never } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: q.take,
      include: { repo: { select: { slug: true, provider: true, projectId: true } } },
    })
  })

  app.post('/sync', async () => {
    await pipelineQueue.add('sync-all', {}, { removeOnComplete: 20 })
    return { queued: true }
  })
}

export default routes
