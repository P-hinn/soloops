/**
 * The clock.
 *
 * What makes time tracking more than two timestamps is three rules, and all
 * three live here rather than in the route, because two other surfaces book
 * time as well — the automation connector and the MCP server — and a booking
 * made there has to be worth the same money as one made by hand:
 *
 *  - **One running timer.** Starting a second one stops the first instead of
 *    double-tracking.
 *  - **A booking carries its rate.** Resolved when it is made, not when it is
 *    invoiced, so a later rate change cannot rewrite history.
 *  - **A booking that is invoiced is settled.** It may not be deleted.
 */
import type { TimeSource } from '@prisma/client'
import { prisma } from '../db.js'
import { invoiceDefaults } from '../settings.js'
import { conflict, invalid, notFound } from '../rules.js'

/** What the interface shows with a booking, everywhere it shows one. */
const withLabels = {
  project: { select: { id: true, key: true, name: true, color: true } },
  actionItem: { select: { id: true, title: true } },
} as const

/** Hourly rate: project > client > global default. */
export async function resolveRateCents(projectId: string): Promise<number> {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: { client: true },
  })
  if (project.hourlyRateCents ?? project.client?.hourlyRateCents) {
    return (project.hourlyRateCents ?? project.client?.hourlyRateCents)!
  }
  return (await invoiceDefaults()).hourlyRateCents
}

export type StartTimer = {
  projectId?: string | null
  actionItemId?: string | null
  description?: string
  billable: boolean
  tags: string[]
  source: TimeSource
}

/**
 * Start the clock.
 *
 * On a task the project comes from the task, so a ticket and its booking can
 * never end up on different projects.
 */
export async function startTimer(input: StartTimer) {
  const task = input.actionItemId
    ? await prisma.actionItem.findUniqueOrThrow({ where: { id: input.actionItemId } })
    : null
  const projectId = input.projectId ?? task?.projectId
  if (!projectId) {
    throw invalid('Die Aufgabe hängt an keinem Projekt — Zeiterfassung braucht eines (Stundensatz)')
  }

  // Stop a running timer automatically — no double tracking.
  const running = await prisma.timeEntry.findFirst({ where: { endedAt: null } })
  if (running) await stopEntry(running.id)

  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
  return prisma.timeEntry.create({
    data: {
      projectId,
      clientId: project.clientId,
      actionItemId: input.actionItemId ?? null,
      // Without a description of its own the task title is the better label
      // than an empty line in the report.
      description: input.description || task?.title || '',
      billable: input.billable,
      tags: input.tags,
      source: input.source,
      startedAt: new Date(),
      rateCents: await resolveRateCents(projectId),
    },
    include: withLabels,
  })
}

/**
 * Stop one booking, by id or whichever is running.
 *
 * Idempotent: stopping something that has already stopped gives back what is
 * there. Two clients racing on the same stop button must not produce two
 * different durations.
 */
export async function stopEntry(id: string) {
  const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id } })
  if (entry.endedAt) return entry
  const endedAt = new Date()
  return prisma.timeEntry.update({
    where: { id },
    data: {
      endedAt,
      durationSec: Math.round((endedAt.getTime() - entry.startedAt.getTime()) / 1000),
    },
    include: withLabels,
  })
}

export async function stopTimer(id?: string) {
  const running = id
    ? await prisma.timeEntry.findUnique({ where: { id } })
    : await prisma.timeEntry.findFirst({ where: { endedAt: null } })
  if (!running) throw notFound('Kein laufender Timer')
  return stopEntry(running.id)
}

export type LogTime = {
  projectId: string
  actionItemId?: string | null
  description: string
  startedAt: string | Date
  endedAt: string | Date
  billable: boolean
  tags: string[]
  rateCents?: number | null
  source?: TimeSource
}

/** A booking written down after the fact. */
export async function logTime(input: LogTime) {
  const startedAt = new Date(input.startedAt)
  const endedAt = new Date(input.endedAt)
  if (endedAt <= startedAt) throw invalid('Ende muss nach dem Start liegen')

  const project = await prisma.project.findUniqueOrThrow({ where: { id: input.projectId } })
  return prisma.timeEntry.create({
    data: {
      projectId: input.projectId,
      clientId: project.clientId,
      actionItemId: input.actionItemId ?? null,
      description: input.description,
      startedAt,
      endedAt,
      durationSec: seconds(startedAt, endedAt),
      billable: input.billable,
      tags: input.tags,
      source: input.source ?? 'MANUAL',
      rateCents: input.rateCents ?? (await resolveRateCents(input.projectId)),
    },
  })
}

export type UpdateTime = Partial<Omit<LogTime, 'projectId'>> & { projectId?: string }

export async function updateTime(id: string, input: UpdateTime) {
  const current = await prisma.timeEntry.findUniqueOrThrow({ where: { id } })
  const startedAt = input.startedAt ? new Date(input.startedAt) : current.startedAt
  const endedAt = input.endedAt ? new Date(input.endedAt) : current.endedAt
  return prisma.timeEntry.update({
    where: { id },
    data: {
      description: input.description,
      billable: input.billable,
      tags: input.tags,
      rateCents: input.rateCents,
      projectId: input.projectId,
      actionItemId: input.actionItemId,
      startedAt,
      endedAt,
      durationSec: endedAt ? seconds(startedAt, endedAt) : 0,
    },
  })
}

/** Seconds between two moments, rounded — the one place that does it. */
export function seconds(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 1000)
}

export async function deleteTime(id: string) {
  const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id } })
  // The hours were worked and are on an invoice. Deleting the booking would
  // take the line item's basis away.
  if (entry.invoiceItemId) throw conflict('Eintrag ist bereits abgerechnet')
  await prisma.timeEntry.delete({ where: { id } })
}

export type TimeFilter = {
  projectId?: string
  clientId?: string
  actionItemId?: string
  from?: string
  to?: string
  billable?: boolean
  unbilledOnly?: boolean
  take?: number
}

/** The filter behind the list — shared with the unbilled view. */
export function timeWhere(q: TimeFilter) {
  return {
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
  }
}

export function listTime(q: TimeFilter) {
  return prisma.timeEntry.findMany({
    where: timeWhere(q),
    orderBy: { startedAt: 'desc' },
    take: q.take ?? 200,
    include: {
      ...withLabels,
      client: { select: { id: true, name: true } },
      // What the window says was done. Subject and link only — the body is
      // for the repository, not for a list of bookings.
      commits: {
        select: { sha: true, subject: true, url: true, committedAt: true },
        orderBy: { committedAt: 'asc' },
      },
    },
  })
}

/** Weekly/monthly report, grouped by project. */
export async function timeReport(from: string, to: string, billableOnly = false) {
  const defaults = await invoiceDefaults()
  const grouped = await prisma.timeEntry.groupBy({
    by: ['projectId'],
    where: {
      startedAt: { gte: new Date(from), lte: new Date(to) },
      endedAt: { not: null },
      ...(billableOnly ? { billable: true } : {}),
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
    const rate = project?.hourlyRateCents ?? defaults.hourlyRateCents
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
    from,
    to,
    totalSeconds: rows.reduce((s, r) => s + r.seconds, 0),
    totalValueCents: rows.reduce((s, r) => s + r.valueCents, 0),
    rows: rows.sort((a, b) => b.seconds - a.seconds),
  }
}

/** The running timer. There is never more than one. */
export function runningEntry() {
  return prisma.timeEntry.findFirst({
    where: { endedAt: null },
    include: withLabels,
    orderBy: { startedAt: 'desc' },
  })
}
