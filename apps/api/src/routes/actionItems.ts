import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { emitAutomationEvent } from '../services/automationDelivery.js'
import { clearFollowUp, completeFollowUp } from '../services/leads.js'
import { readLinkState } from '../services/taskLinkState.js'
import { parseTaskLink } from '../services/taskLinks.js'
import { BOARD_COLUMNS, columnPatch, isFollowUpTask, spreadPositions } from '../services/tasks.js'
import { createTask, endOfColumn } from '../services/taskWrite.js'

/**
 * Tasks — the to-do list, the board, and what hangs off a ticket.
 *
 * Still `ActionItem` on the wire and in the database, because that is what it
 * has always been: the open points out of meetings and projects. What came
 * later is the rest of a ticket — a board column, a client of its own, the
 * time booked against it and the commits that closed it.
 */

const idParam = z.object({ id: z.string() })
const linkParam = z.object({ id: z.string(), linkId: z.string() })

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

/** The tokens the link reader needs, out of the configuration. */
const providerAccess = () => ({
  githubToken: env.GITHUB_TOKEN,
  gitlabToken: env.GITLAB_TOKEN,
  gitlabHost: env.GITLAB_HOST,
})

const listed = {
  project: { select: { id: true, key: true, name: true, color: true } },
  client: { select: { id: true, name: true } },
  meeting: { select: { id: true, title: true } },
  lead: { select: { id: true, title: true, stage: true } },
  links: { orderBy: { createdAt: 'asc' } },
} as const

/**
 * Hours booked per task, in one query for the whole list.
 *
 * The board shows it on every card, so doing it per row would be a query per
 * card. Tasks without time are simply absent from the result and read as 0.
 */
async function trackedSecByTask(ids: string[]): Promise<Record<string, number>> {
  if (ids.length === 0) return {}
  const grouped = await prisma.timeEntry.groupBy({
    by: ['actionItemId'],
    where: { actionItemId: { in: ids } },
    _sum: { durationSec: true },
  })
  return Object.fromEntries(
    grouped.map((row) => [row.actionItemId!, row._sum.durationSec ?? 0]),
  ) as Record<string, number>
}

/**
 * A ticket that was just closed, and what that means elsewhere.
 *
 * A follow-up's own ticket (see services/leadTasks.ts) closes the follow-up
 * with it: ticking the card off on the board is the same act as saying you
 * chased the lead up, and the two must not end up disagreeing. Everything
 * else only emits the event.
 */
async function onTaskClosed(
  task: {
    id: string
    title: string
    assignee: string | null
    dueOn: Date | null
    projectId: string | null
    clientId: string | null
    meetingId: string | null
    leadId: string | null
    source: string
  },
  app: { log: { warn: (message: string) => void } },
): Promise<void> {
  await emitAutomationEvent({
    event: 'TASK_COMPLETED',
    projectId: task.projectId,
    path: task.leadId
      ? `/leads/${task.leadId}`
      : task.projectId
        ? `/projects/${task.projectId}`
        : null,
    data: {
      id: task.id,
      title: task.title,
      assignee: task.assignee,
      dueOn: task.dueOn,
      projectId: task.projectId,
      clientId: task.clientId,
      meetingId: task.meetingId,
      leadId: task.leadId,
    },
  })

  if (!isFollowUpTask(task)) return
  // The lead side writes its own history entry ("Nachgefasst"), which is the
  // point: a follow-up ticked off on the board still counts as contact and
  // resets the staleness counter. It cannot close this ticket back, because
  // it only looks for open ones.
  await completeFollowUp(task.leadId!).catch((err: Error) =>
    app.log.warn(`[tasks] Wiedervorlage ${task.leadId}: ${err.message}`),
  )
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({
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
      })
      .parse(req.query)

    const items = await prisma.actionItem.findMany({
      where: {
        ...(q.open ? { done: false } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(q.meetingId ? { meetingId: q.meetingId } : {}),
        ...(q.leadId ? { leadId: q.leadId } : {}),
        ...(q.overdue ? { done: false, dueOn: { lt: new Date() } } : {}),
        ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ done: 'asc' }, { position: 'asc' }, { dueOn: 'asc' }, { createdAt: 'asc' }],
      take: q.take,
      include: listed,
    })

    const tracked = await trackedSecByTask(items.map((item) => item.id))
    return items.map((item) => ({ ...item, trackedSec: tracked[item.id] ?? 0 }))
  })

  /** One task with everything the detail panel shows. */
  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const item = await prisma.actionItem.findUniqueOrThrow({
      where: { id },
      include: {
        ...listed,
        timeEntries: {
          orderBy: { startedAt: 'desc' },
          take: 50,
          include: { project: { select: { id: true, key: true, name: true } } },
        },
      },
    })
    const tracked = await trackedSecByTask([id])
    return { ...item, trackedSec: tracked[id] ?? 0 }
  })

  app.post('/', async (req, reply) => {
    const data = itemInput.parse(req.body)
    // Project, client and position are decided in one place for every caller
    // — see services/taskWrite.ts.
    const created = await createTask(data, listed)
    return reply.code(201).send({ ...created, trackedSec: 0 })
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = itemInput.partial().parse(req.body)
    // The previous state decides whether this is an event: ticking an item
    // that was already done is a no-op, and a workflow should not see it.
    const before = await prisma.actionItem.findUniqueOrThrow({
      where: { id },
      select: { done: true, status: true },
    })
    // A card moved into another column by any route other than a drag has no
    // position of its own yet; without this it keeps the rank it had in the
    // old column and lands somewhere in the middle of the new one.
    const movesColumn =
      (data.status !== undefined && data.status !== before.status) ||
      (data.done !== undefined && data.done !== before.done)
    const position =
      data.position ??
      (movesColumn
        ? await endOfColumn((data.done ?? before.done) ? null : (data.status ?? before.status))
        : undefined)

    const updated = await prisma.actionItem.update({
      where: { id },
      data: { ...data, ...(position === undefined ? {} : { position }) },
      include: listed,
    })

    if (!before.done && updated.done) await onTaskClosed(updated, app)

    const tracked = await trackedSecByTask([id])
    return { ...updated, trackedSec: tracked[id] ?? 0 }
  })

  /**
   * A column after a drag: the ids in the order they now have.
   *
   * The whole column rather than the one card that moved — see
   * services/tasks.ts. Deliberately not in a transaction: every write is an
   * op in the sync log, and ops for a write that rolled back would be worse
   * than a column that is briefly sorted halfway.
   */
  app.post('/order', async (req) => {
    const body = z
      .object({ column: z.enum(BOARD_COLUMNS), ids: z.array(z.string()).max(500) })
      .parse(req.body)

    const patch = columnPatch(body.column)
    const positions = spreadPositions(body.ids.length)

    // Read before writing: which of these were still open is what decides
    // whether a drop into "Erledigt" is an event. Afterwards they all look
    // closed, and re-sorting the done column would fire the event again for
    // every card in it.
    const before = await prisma.actionItem.findMany({
      where: { id: { in: body.ids } },
      select: { id: true, done: true },
    })
    const wasOpen = new Set(before.filter((item) => !item.done).map((item) => item.id))

    for (const [index, id] of body.ids.entries()) {
      await prisma.actionItem.update({
        where: { id },
        data: { ...patch, position: positions[index]! },
      })
    }

    // Moving into "Erledigt" closes tasks, and a workflow listening for that
    // has to see it however it happened.
    if (body.column === 'DONE' && wasOpen.size > 0) {
      const closed = await prisma.actionItem.findMany({ where: { id: { in: [...wasOpen] } } })
      for (const item of closed) await onTaskClosed(item, app)
    }

    return { ok: true, moved: body.ids.length }
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const task = await prisma.actionItem.findUniqueOrThrow({ where: { id } })

    // Throwing away a follow-up's own ticket says the follow-up was wrong,
    // not that the lead needs no chasing on a date nobody can see any more.
    // `clearFollowUp` takes the date off and deletes this row on its way.
    if (isFollowUpTask(task) && !task.done) {
      await clearFollowUp(task.leadId!)
      return reply.code(204).send()
    }

    await prisma.actionItem.delete({ where: { id } })
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
  app.post('/:id/links', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const { url } = z.object({ url: z.string().min(1) }).parse(req.body)

    const parsed = parseTaskLink(url, env.GITLAB_HOST)
    if (!parsed) {
      return reply.code(422).send({
        error: 'Kein erkennbarer Commit-, PR- oder Issue-Link (GitHub oder GitLab)',
      })
    }

    await prisma.actionItem.findUniqueOrThrow({ where: { id }, select: { id: true } })
    const state = await readLinkState(parsed, providerAccess()).catch((err: Error) => {
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
  })

  /** Re-read every link on a task — "is the PR merged by now". */
  app.post('/:id/links/refresh', async (req) => {
    const { id } = idParam.parse(req.params)
    const links = await prisma.taskLink.findMany({ where: { actionItemId: id } })

    for (const link of links) {
      const state = await readLinkState(link, providerAccess()).catch((err: Error) => {
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

  app.delete('/:id/links/:linkId', async (req, reply) => {
    const { id, linkId } = linkParam.parse(req.params)
    await prisma.taskLink.delete({ where: { id: linkId, actionItemId: id } })
    return reply.code(204).send()
  })
}

export default routes
