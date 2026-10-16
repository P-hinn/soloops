import type { ActionItem, Prisma, TaskStatus } from '@prisma/client'
import { prisma } from '../db.js'
import { nextPosition } from './tasks.js'

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
