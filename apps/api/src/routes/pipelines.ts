import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { serviceKeys } from '@soloops/core/settings.js'
import { z } from 'zod'
import { idParam, repoInput } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { commitQueue, pipelineQueue } from '@soloops/core/queue.js'
import { syncRepo } from '@soloops/core/services/pipelines.js'
import { projectCommits, syncRepoCommits } from '@soloops/core/services/repoCommits.js'

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/repos', async () => {
    const keys = await serviceKeys()
    const repos = await prisma.pipelineRepo.findMany({
      orderBy: { slug: 'asc' },
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        runs: { orderBy: { startedAt: 'desc' }, take: 8 },
      },
    })
    return {
      configured: { github: !!keys.github, gitlab: !!keys.gitlab },
      repos,
    }
  })

  app.post('/repos', { schema: { body: repoInput } }, async (req, reply) => {
    const data = req.body
    const repo = await prisma.pipelineRepo.upsert({
      where: { provider_slug: { provider: data.provider, slug: data.slug } },
      create: data,
      update: { branch: data.branch, projectId: data.projectId ?? null, enabled: data.enabled },
    })
    await pipelineQueue.add('sync-repo', { repoId: repo.id }, { removeOnComplete: 20 })
    return reply.code(201).send(repo)
  })

  app.patch(
    '/repos/:id',
    { schema: { params: idParam, body: repoInput.partial() } },
    async (req) => {
      const { id } = req.params
      const data = req.body
      return prisma.pipelineRepo.update({ where: { id }, data })
    },
  )

  app.delete('/repos/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    await prisma.pipelineRepo.delete({ where: { id } })
    return reply.code(204).send()
  })

  app.post('/repos/:id/sync', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return syncRepo(id)
  })

  /** Mirror one repository's commits now. */
  app.post('/repos/:id/commits/sync', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return syncRepoCommits(id)
  })

  /**
   * The mirrored commits of a project in a window. What the time view shows
   * next to a booking, and what answers "was anything else done here".
   */
  app.get(
    '/commits',
    {
      schema: {
        querystring: z.object({
          projectId: z.string(),
          from: z.string(),
          to: z.string(),
        }),
      },
    },
    async (req) => {
      const q = req.query
      return projectCommits(q.projectId, new Date(q.from), new Date(q.to))
    },
  )

  app.get(
    '/runs',
    {
      schema: {
        querystring: z.object({
          projectId: z.string().optional(),
          status: z.string().optional(),
          take: z.coerce.number().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query

      return prisma.pipelineRun.findMany({
        where: {
          ...(q.projectId ? { repo: { projectId: q.projectId } } : {}),
          ...(q.status ? { status: q.status as never } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: q.take,
        include: { repo: { select: { slug: true, provider: true, projectId: true } } },
      })
    },
  )

  app.post('/sync', async () => {
    await pipelineQueue.add('sync-all', {}, { removeOnComplete: 20 })
    // The commit mirror rides along: both read the same repositories, and a
    // manual sync is meant to bring everything up to date, not half of it.
    await commitQueue.add('sync', {}, { removeOnComplete: 20 })
    return { queued: true }
  })
}

export default routes
