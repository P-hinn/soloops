import type { ActionItem, Lead } from '@prisma/client'
import { prisma } from '../db.js'
import { emitAutomationEvent } from './automationDelivery.js'
import { FOLLOW_UP_SOURCE, followUpTaskTitle } from './tasks.js'
import { createTask } from './taskWrite.js'

/**
 * A follow-up and its ticket.
 *
 * "In sechs Monaten nochmal fragen" used to live in two columns on the lead
 * and nowhere else: it had no place on the board, no time could be booked on
 * it, and the only thing that ever reminded you of it was a notification. Now
 * every follow-up carries a task, so the thing you actually have to do shows
 * up where the rest of the work is.
 *
 * The ticket is owned by the follow-up, which is what `source = "LEAD"`
 * marks: those are created, moved and closed by the functions below, and they
 * are the only ones. A task you write yourself and hang on a lead keeps its
 * `leadId` and is never touched from here — otherwise chasing a lead up would
 * silently tick off the three things you noted down next to it.
 *
 * The other direction lives in routes/actionItems.ts: ticking the ticket off
 * completes the follow-up. Both ends go through here, so the date on the lead
 * and the card on the board cannot say different things.
 */

/** The open ticket a follow-up keeps for itself, if there is one. */
async function openTicket(leadId: string): Promise<ActionItem | null> {
  return prisma.actionItem.findFirst({
    where: { leadId, source: FOLLOW_UP_SOURCE, done: false },
    orderBy: { createdAt: 'asc' },
  })
}

/**
 * Put the follow-up on the board, or move the card that is already there.
 *
 * Moving the date is the common case — a lead gets pushed by a week three
 * times before anyone calls — and it must not leave three cards behind.
 */
export async function syncFollowUpTask(
  lead: Pick<Lead, 'id' | 'title' | 'clientId' | 'projectId' | 'followUpOn' | 'followUpNote'>,
): Promise<ActionItem | null> {
  if (!lead.followUpOn) return dropFollowUpTask(lead.id)

  const title = followUpTaskTitle(lead.title, lead.followUpNote)
  const existing = await openTicket(lead.id)

  if (existing) {
    return prisma.actionItem.update({
      where: { id: existing.id },
      // Project and client can have been filled in on the lead since, so they
      // travel with every change rather than only at creation.
      data: {
        title,
        dueOn: lead.followUpOn,
        clientId: lead.clientId,
        projectId: lead.projectId,
      },
    })
  }

  return createTask({
    title,
    dueOn: lead.followUpOn,
    leadId: lead.id,
    source: FOLLOW_UP_SOURCE,
    status: 'TODO',
  })
}

/**
 * Chased up: the ticket is done.
 *
 * Returns the task that was closed, or null when there was none — the caller
 * uses that to decide whether this was an event. Closing one that is already
 * closed is not.
 */
export async function closeFollowUpTask(leadId: string): Promise<ActionItem | null> {
  const open = await openTicket(leadId)
  if (!open) return null

  const closed = await prisma.actionItem.update({
    where: { id: open.id },
    data: { done: true },
  })

  await emitAutomationEvent({
    event: 'TASK_COMPLETED',
    projectId: closed.projectId,
    path: `/leads/${leadId}`,
    data: {
      id: closed.id,
      title: closed.title,
      assignee: closed.assignee,
      dueOn: closed.dueOn,
      projectId: closed.projectId,
      clientId: closed.clientId,
      leadId,
    },
  })
  return closed
}

/**
 * The follow-up was a mistake — and so is its ticket.
 *
 * Deleted rather than ticked off, because a wrong date is not work that got
 * done. Only while it is still open: the moment time has been booked on it or
 * it has been closed, it is history and stays.
 */
export async function dropFollowUpTask(leadId: string): Promise<null> {
  const open = await openTicket(leadId)
  if (!open) return null

  const booked = await prisma.timeEntry.count({ where: { actionItemId: open.id } })
  if (booked > 0) {
    await prisma.actionItem.update({ where: { id: open.id }, data: { done: true } })
    return null
  }

  await prisma.actionItem.delete({ where: { id: open.id } })
  return null
}
