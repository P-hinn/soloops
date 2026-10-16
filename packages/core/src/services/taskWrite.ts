import type { ActionItem, Prisma, TaskStatus } from '@prisma/client'
import { prisma } from '../db.js'
import { emitAutomationEvent } from './automationDelivery.js'
import { clearFollowUp, completeFollowUp } from './leads.js'
import {
  BOARD_COLUMNS,
  columnPatch,
  isFollowUpTask,
  nextPosition,
  spreadPositions,
} from './tasks.js'

/**
 * The one place a task comes into being.
 *
 * There are three callers — the API route, the n8n connector and the
 * follow-up on a lead — and they used to each build the row themselves. That
 * went wrong exactly the way two copies of a rule always do: the connector
 * knew nothing about taking the client from the project, so a task an
 * automation created on a customer project showed up under no customer at
 * all, and nothing about positions, so every one of them landed at the top of
 * the backlog.
 *
 * What the rule is, in one place:
 *
 *  - a task on a meeting belongs to that meeting's project,
 *  - a task on a lead belongs to that lead's project,
 *  - the client comes from whichever of those was found, unless one was named,
 *  - and a new card goes to the end of its column, not the front.
 */

export type NewTask = {
  title: string
  done?: boolean
  status?: TaskStatus
  dueOn?: Date | null
  assignee?: string | null
  projectId?: string | null
  clientId?: string | null
  meetingId?: string | null
  leadId?: string | null
  position?: number
  source?: string
}

export async function createTask<T extends Prisma.ActionItemInclude>(
  input: NewTask,
  include?: T,
): Promise<ActionItem> {
  const meeting = input.meetingId
    ? await prisma.meeting.findUniqueOrThrow({ where: { id: input.meetingId } })
    : null
  const lead = input.leadId
    ? await prisma.lead.findUniqueOrThrow({ where: { id: input.leadId } })
    : null

  const projectId = input.projectId ?? meeting?.projectId ?? lead?.projectId ?? null
  const project = projectId
    ? await prisma.project.findUniqueOrThrow({ where: { id: projectId } })
    : null
  const clientId =
    input.clientId ?? meeting?.clientId ?? lead?.clientId ?? project?.clientId ?? null

  const status = input.status ?? 'TODO'
  const position = input.position ?? (await endOfColumn(input.done ? null : status))

  return prisma.actionItem.create({
    data: {
      title: input.title,
      done: input.done ?? false,
      status,
      dueOn: input.dueOn ?? null,
      assignee: input.assignee ?? null,
      source: input.source ?? 'MANUAL',
      meetingId: input.meetingId ?? null,
      leadId: input.leadId ?? null,
      projectId,
      clientId,
      position,
    },
    ...(include ? { include } : {}),
  })
}

/**
 * The position behind everything in a column. `null` means the closed column,
 * which is ordered by when things were ticked off rather than by hand — any
 * position will do there.
 */
export async function endOfColumn(status: TaskStatus | null): Promise<number> {
  if (status === null) return 0
  const column = await prisma.actionItem.findMany({
    where: { done: false, status },
    select: { position: true },
  })
  return nextPosition(column.map((row) => row.position))
}

// --- Everything else a ticket does -------------------------------------------
//
// Moved out of the route so the automation connector reaches the same rules:
// before this, a task completed through the connector emitted its event but
// skipped the follow-up coupling below, so a follow-up ticked off by a
// workflow left its lead waiting for a date nobody could see any more.

/** Where a service says something went wrong without stopping. */
export type Warn = (message: string) => void
const defaultWarn: Warn = (message) => console.warn(message)

/** What the interface shows with a task, wherever it shows one. */
export const taskIncludes = {
  project: { select: { id: true, key: true, name: true, color: true } },
  client: { select: { id: true, name: true } },
  meeting: { select: { id: true, title: true } },
  lead: { select: { id: true, title: true, stage: true } },
  links: { orderBy: { createdAt: 'asc' } },
} as const satisfies Prisma.ActionItemInclude

/**
 * Hours booked per task, in one query for the whole list.
 *
 * The board shows it on every card, so doing it per row would be a query per
 * card. Tasks without time are simply absent from the result and read as 0.
 */
export async function trackedSecByTask(ids: string[]): Promise<Record<string, number>> {
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

type ClosedTask = {
  id: string
  title: string
  assignee: string | null
  dueOn: Date | null
  projectId: string | null
  clientId: string | null
  meetingId: string | null
  leadId: string | null
  source: string
}

/**
 * A ticket that was just closed, and what that means elsewhere.
 *
 * A follow-up's own ticket (see services/leadTasks.ts) closes the follow-up
 * with it: ticking the card off on the board is the same act as saying you
 * chased the lead up, and the two must not end up disagreeing. Everything
 * else only emits the event.
 */
export async function onTaskClosed(task: ClosedTask, warn: Warn = defaultWarn): Promise<void> {
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
    warn(`[tasks] Wiedervorlage ${task.leadId}: ${err.message}`),
  )
}

export type TaskFilter = {
  open?: boolean
  status?: TaskStatus
  projectId?: string
  clientId?: string
  meetingId?: string
  leadId?: string
  overdue?: boolean
  q?: string
  take?: number
}

export async function listTasks(q: TaskFilter) {
  const items = await prisma.actionItem.findMany({
    where: {
      ...(q.open ? { done: false } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.meetingId ? { meetingId: q.meetingId } : {}),
      ...(q.leadId ? { leadId: q.leadId } : {}),
      ...(q.overdue ? { done: false, dueOn: { lt: new Date() } } : {}),
      ...(q.q ? { title: { contains: q.q, mode: 'insensitive' as const } } : {}),
    },
    orderBy: [{ done: 'asc' }, { position: 'asc' }, { dueOn: 'asc' }, { createdAt: 'asc' }],
    take: q.take ?? 200,
    include: taskIncludes,
  })

  const tracked = await trackedSecByTask(items.map((item) => item.id))
  return items.map((item) => ({ ...item, trackedSec: tracked[item.id] ?? 0 }))
}

/** One task with everything the detail panel shows. */
export async function getTask(id: string) {
  const item = await prisma.actionItem.findUniqueOrThrow({
    where: { id },
    include: {
      ...taskIncludes,
      timeEntries: {
        orderBy: { startedAt: 'desc' },
        take: 50,
        include: { project: { select: { id: true, key: true, name: true } } },
      },
    },
  })
  const tracked = await trackedSecByTask([id])
  return { ...item, trackedSec: tracked[id] ?? 0 }
}

export async function updateTask(id: string, data: Partial<NewTask>, warn: Warn = defaultWarn) {
  // The previous state decides whether this is an event: ticking an item that
  // was already done is a no-op, and a workflow should not see it.
  const before = await prisma.actionItem.findUniqueOrThrow({
    where: { id },
    select: { done: true, status: true },
  })
  // A card moved into another column by any route other than a drag has no
  // position of its own yet; without this it keeps the rank it had in the old
  // column and lands somewhere in the middle of the new one.
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
    include: taskIncludes,
  })

  if (!before.done && updated.done) await onTaskClosed(updated, warn)

  const tracked = await trackedSecByTask([id])
  return { ...updated, trackedSec: tracked[id] ?? 0 }
}

/**
 * A column after a drag: the ids in the order they now have.
 *
 * The whole column rather than the one card that moved — see services/tasks.ts.
 * Deliberately not in a transaction: every write is an op in the sync log, and
 * ops for a write that rolled back would be worse than a column that is
 * briefly sorted halfway.
 */
export async function reorderColumn(
  column: (typeof BOARD_COLUMNS)[number],
  ids: string[],
  warn: Warn = defaultWarn,
) {
  const patch = columnPatch(column)
  const positions = spreadPositions(ids.length)

  // Read before writing: which of these were still open is what decides
  // whether a drop into "Erledigt" is an event. Afterwards they all look
  // closed, and re-sorting the done column would fire the event again for
  // every card in it.
  const before = await prisma.actionItem.findMany({
    where: { id: { in: ids } },
    select: { id: true, done: true },
  })
  const wasOpen = new Set(before.filter((item) => !item.done).map((item) => item.id))

  for (const [index, id] of ids.entries()) {
    await prisma.actionItem.update({
      where: { id },
      data: { ...patch, position: positions[index]! },
    })
  }

  // Moving into "Erledigt" closes tasks, and a workflow listening for that has
  // to see it however it happened.
  if (column === 'DONE' && wasOpen.size > 0) {
    const closed = await prisma.actionItem.findMany({ where: { id: { in: [...wasOpen] } } })
    for (const item of closed) await onTaskClosed(item, warn)
  }

  return { ok: true, moved: ids.length }
}

export async function deleteTask(id: string) {
  const task = await prisma.actionItem.findUniqueOrThrow({ where: { id } })

  // Throwing away a follow-up's own ticket says the follow-up was wrong, not
  // that the lead needs no chasing on a date nobody can see any more.
  // `clearFollowUp` takes the date off and deletes this row on its way.
  if (isFollowUpTask(task) && !task.done) {
    await clearFollowUp(task.leadId!)
    return
  }

  await prisma.actionItem.delete({ where: { id } })
}

/** Mark one task done — the shortcut every surface has. */
export function completeTask(id: string, warn: Warn = defaultWarn) {
  return updateTask(id, { done: true }, warn)
}
