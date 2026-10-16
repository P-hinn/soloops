import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { timeEntryInput, timerStartInput } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { commitQueue } from '../queue.js'
import { enrichPendingTimeEntries, enrichTimeEntry, windowCommits } from '../services/timeEnrich.js'
import { syncAllRepoCommits } from '../services/repoCommits.js'

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
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        actionItem: { select: { id: true, title: true } },
      },
      orderBy: { startedAt: 'desc' },
    })
  })

  app.post('/start', async (req, reply) => {
    const data = timerStartInput.parse(req.body)

    // On a task the project comes from the task, so a ticket and its booking
    // can never end up on different projects.
    const task = data.actionItemId
      ? await prisma.actionItem.findUniqueOrThrow({ where: { id: data.actionItemId } })
      : null
    const projectId = data.projectId ?? task?.projectId
    if (!projectId) {
      return reply.code(422).send({
        error: 'Die Aufgabe hängt an keinem Projekt — Zeiterfassung braucht eines (Stundensatz)',
      })
    }

    // Stop a running timer automatically — no double tracking.
    const running = await prisma.timeEntry.findFirst({ where: { endedAt: null } })
    if (running) await stopEntry(running.id)

    const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    const entry = await prisma.timeEntry.create({
      data: {
        projectId,
        clientId: project.clientId,
        actionItemId: data.actionItemId ?? null,
        // Without a description of its own the task title is the better
        // label than an empty line in the report.
        description: data.description || task?.title || '',
        billable: data.billable,
        tags: data.tags,
        source: data.source,
        startedAt: new Date(),
        rateCents: await resolveRateCents(projectId),
      },
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        actionItem: { select: { id: true, title: true } },
      },
    })
    return reply.code(201).send(entry)
  })

  app.post('/stop', async (req, reply) => {
    const body = z.object({ id: z.string().optional() }).parse(req.body ?? {})
    const running = body.id
      ? await prisma.timeEntry.findUnique({ where: { id: body.id } })
      : await prisma.timeEntry.findFirst({ where: { endedAt: null } })
    if (!running) return reply.code(404).send({ error: 'Kein laufender Timer' })
    const stopped = await stopEntry(running.id)

    // The commits of the last hour are usually pushed after the clock has
    // stopped, so the text is fetched with a delay rather than right now.
    // Redis being down must not cost the stop — the periodic run would pick
    // the entry up anyway.
    await commitQueue
      .add(
        'enrich-entry',
        { timeEntryId: stopped.id },
        { delay: 180_000, removeOnComplete: 50, removeOnFail: 50 },
      )
      .catch((err) => app.log.warn(`[commits] Nachtrag nicht eingeplant: ${err.message}`))

    return stopped
  })

  app.get('/', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        clientId: z.string().optional(),
        actionItemId: z.string().optional(),
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
        ...(q.actionItemId ? { actionItemId: q.actionItemId } : {}),
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
        actionItem: { select: { id: true, title: true } },
        // What the window says was done. Subject and link only — the body is
        // for the repository, not for a list of bookings.
        commits: {
          select: { sha: true, subject: true, url: true, committedAt: true },
          orderBy: { committedAt: 'asc' },
        },
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
        actionItemId: data.actionItemId ?? null,
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
        actionItemId: data.actionItemId,
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

  /**
   * Give one entry its text: the commits of its window, as one line.
   *
   * Mirrors that project's repositories first by default — right after
   * stopping the clock the worker's next beat is minutes away, and the point
   * of the button is to see the result now.
   */
  app.post('/:id/enrich', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ sync: z.boolean().default(true) }).parse(req.body ?? {})
    try {
      return await enrichTimeEntry(id, body.sync)
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
  })

  /**
   * The commits that fall into this booking's window. For a running timer
   * the window ends now, which is what the overlay shows while it counts.
   */
  app.get('/:id/commits', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    try {
      return await windowCommits(id)
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })

  /** Every finished entry that still wants one. Mirror first, then match. */
  app.post('/enrich-pending', async () => {
    const mirrored = await syncAllRepoCommits()
    const result = await enrichPendingTimeEntries()
    return { ...result, repos: mirrored.repos, commits: mirrored.commits }
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
    include: {
      project: { select: { id: true, key: true, name: true, color: true } },
      actionItem: { select: { id: true, title: true } },
    },
  })
}

export default routes
