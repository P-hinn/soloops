import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { serviceKeys } from '@soloops/core/settings.js'
import { idParam, linkParam } from '@soloops/shared'
import { z } from 'zod'
import { prisma } from '@soloops/core/db.js'
import { env } from '@soloops/core/env.js'
import { readLinkState } from '@soloops/core/services/taskLinkState.js'
import { parseTaskLink } from '@soloops/core/services/taskLinks.js'
import { BOARD_COLUMNS } from '@soloops/core/services/tasks.js'
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  reorderColumn,
  taskIncludes,
  updateTask,
} from '@soloops/core/services/taskWrite.js'

/**
 * Tasks — the to-do list, the board, and what hangs off a ticket.
 *
 * Still `ActionItem` on the wire and in the database, because that is what it
 * has always been: the open points out of meetings and projects. What came
 * later is the rest of a ticket — a board column, a client of its own, the
 * time booked against it and the commits that closed it.
 */

/**
 * `z.coerce.boolean()` would read "false" as true — every non-empty string is
 * truthy. Query parameters therefore go through this instead.
 */
const boolParam = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

const taskStatus = z.enum(['TODO', 'DOING', 'BLOCKED'])

const itemInput = z.object({
  title: z.string().min(1),
  done: z.boolean().optional(),
  status: taskStatus.optional(),
  dueOn: z.coerce.date().nullish(),
  assignee: z.string().nullish(),
  projectId: z.string().nullish(),
  clientId: z.string().nullish(),
  meetingId: z.string().nullish(),
  leadId: z.string().nullish(),
  position: z.number().int().optional(),
  source: z.enum(['MANUAL', 'AI', 'MCP']).default('MANUAL'),
})

/** The tokens the link reader needs, out of the settings. */
async function providerAccess() {
  const keys = await serviceKeys()
  return {
    githubToken: keys.github,
    gitlabToken: keys.gitlab,
    gitlabHost: keys.gitlabHost ?? env.GITLAB_HOST,
  }
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          open: boolParam.default('true'),
          status: taskStatus.optional(),
          projectId: z.string().optional(),
          clientId: z.string().optional(),
          meetingId: z.string().optional(),
          leadId: z.string().optional(),
          /** Only what is already overdue — the one filter worth a shortcut. */
          overdue: boolParam.optional(),
          q: z.string().optional(),
          take: z.coerce.number().max(500).default(200),
        }),
      },
    },
    async (req) => {
      const q = req.query
      return listTasks(q)
    },
  )

  /** One task with everything the detail panel shows. */
  app.get('/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return getTask(id)
  })

  app.post('/', { schema: { body: itemInput } }, async (req, reply) => {
    const data = req.body
    // Project, client and position are decided in one place for every caller
    // — see services/taskWrite.ts.
    const created = await createTask(data, taskIncludes)
    return reply.code(201).send({ ...created, trackedSec: 0 })
  })

  app.patch('/:id', { schema: { params: idParam, body: itemInput.partial() } }, async (req) => {
    const { id } = req.params
    const data = req.body
    return updateTask(id, data, (message) => app.log.warn(message))
  })

  /** A column after a drag: the ids in the order they now have. */
  app.post(
    '/order',
    {
      schema: {
        body: z.object({ column: z.enum(BOARD_COLUMNS), ids: z.array(z.string()).max(500) }),
      },
    },
    async (req) => {
      const body = req.body
      return reorderColumn(body.column, body.ids, (message) => app.log.warn(message))
    },
  )

  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    await deleteTask(id)
    return reply.code(204).send()
  })

  // -------------------------------------------------------------------------
  // Commits, pull requests and issues
  // -------------------------------------------------------------------------

  /**
   * Attach whatever is in the clipboard.
   *
   * The state is read right away so the link arrives with a title instead of
   * a number — but a provider that is down or has no token must not keep the
   * link from being stored, so that part is best-effort.
   */
  app.post(
    '/:id/links',
    { schema: { params: idParam, body: z.object({ url: z.string().min(1) }) } },
    async (req, reply) => {
      const keys = await serviceKeys()
      const { id } = req.params
      const { url } = req.body

      const parsed = parseTaskLink(url, keys.gitlabHost)
      if (!parsed) {
        return reply.code(422).send({
          error: 'Kein erkennbarer Commit-, PR- oder Issue-Link (GitHub oder GitLab)',
        })
      }

      await prisma.actionItem.findUniqueOrThrow({ where: { id }, select: { id: true } })
      const state = await readLinkState(parsed, await providerAccess()).catch((err: Error) => {
        app.log.warn(`[tasks] ${parsed.url}: ${err.message}`)
        return null
      })

      // `owner/repo#12` is stored under the issues URL until the provider says
      // it is a pull request. Without this the corrected row would join the
      // guessed one instead of replacing it, and the task would show the same
      // thing twice.
      if (state?.url && state.url !== parsed.url) {
        await prisma.taskLink.deleteMany({ where: { actionItemId: id, url: parsed.url } })
      }

      const link = await prisma.taskLink.upsert({
        where: { actionItemId_url: { actionItemId: id, url: state?.url ?? parsed.url } },
        create: {
          actionItemId: id,
          provider: parsed.provider,
          kind: state?.kind ?? parsed.kind,
          repo: parsed.repo,
          ref: parsed.ref,
          url: state?.url ?? parsed.url,
          title: state?.title ?? null,
          state: state?.state ?? null,
          author: state?.author ?? null,
          mergedAt: state?.mergedAt ?? null,
          checkedAt: state ? new Date() : null,
        },
        update: state
          ? {
              kind: state.kind ?? parsed.kind,
              title: state.title,
              state: state.state,
              author: state.author,
              mergedAt: state.mergedAt,
              checkedAt: new Date(),
            }
          : {},
      })
      return reply.code(201).send(link)
    },
  )

  /** Re-read every link on a task — "is the PR merged by now". */
  app.post('/:id/links/refresh', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    const links = await prisma.taskLink.findMany({ where: { actionItemId: id } })

    for (const link of links) {
      const state = await readLinkState(link, await providerAccess()).catch((err: Error) => {
        app.log.warn(`[tasks] ${link.url}: ${err.message}`)
        return null
      })
      if (!state) continue
      // One link per iteration: a corrected URL that collides with another
      // row on the same task is the one failure mode here, and it must not
      // take the rest of the refresh down with it.
      await prisma.taskLink
        .update({
          where: { id: link.id },
          data: {
            kind: state.kind ?? link.kind,
            url: state.url ?? link.url,
            title: state.title,
            state: state.state,
            author: state.author,
            mergedAt: state.mergedAt,
            checkedAt: new Date(),
          },
        })
        .catch((err: Error) => app.log.warn(`[tasks] ${link.url}: ${err.message}`))
    }

    return prisma.taskLink.findMany({ where: { actionItemId: id }, orderBy: { createdAt: 'asc' } })
  })

  app.delete('/:id/links/:linkId', { schema: { params: linkParam } }, async (req, reply) => {
    const { id, linkId } = req.params
    await prisma.taskLink.delete({ where: { id: linkId, actionItemId: id } })
    return reply.code(204).send()
  })
}

export default routes
