import type { ActivityKind, LeadStage } from '@prisma/client'
import { prisma } from '../db.js'
import {
  followUpDays,
  followUpDue,
  leadValueCents,
  stalenessDays,
  weightedCents,
  OPEN_STAGES,
  STAGE_LABEL,
  STAGE_PROBABILITY,
} from './leadMath.js'

// The pure arithmetic lives in leadMath.ts (no Prisma, so it stays testable)
// and is re-exported here — callers should only need to know one place.
export {
  followUpDays,
  followUpDue,
  leadValueCents,
  stalenessDays,
  weightedCents,
  OPEN_STAGES,
  STAGE_LABEL,
  STAGE_PROBABILITY,
}

/**
 * Sales logic shared by the API, the worker and the MCP server.
 */

/**
 * Record an activity and mark the lead as touched.
 *
 * The two belong together: a history entry without an updated
 * `lastActivityAt` would keep showing the lead as gone quiet.
 */
export async function touchLead(
  leadId: string,
  activity: { kind: ActivityKind; body: string; occurredAt?: Date; source?: string },
) {
  const occurredAt = activity.occurredAt ?? new Date()

  await prisma.leadActivity.create({
    data: {
      leadId,
      kind: activity.kind,
      body: activity.body,
      occurredAt,
      source: activity.source ?? 'MANUAL',
    },
  })

  // An old mail added after the fact must not make the lead look fresh.
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { lastActivityAt: true },
  })
  if (occurredAt > lead.lastActivityAt) {
    await prisma.lead.update({ where: { id: leadId }, data: { lastActivityAt: occurredAt } })
  }
}

/**
 * Change the stage, with a history entry and a matching probability.
 * A probability you set yourself is only overwritten when the deal closes.
 */
export async function changeStage(leadId: string, stage: LeadStage, note?: string) {
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })
  if (lead.stage === stage) return lead

  const closing = stage === 'WON' || stage === 'LOST'
  const probability = closing
    ? STAGE_PROBABILITY[stage]
    : lead.probability === STAGE_PROBABILITY[lead.stage]
      ? STAGE_PROBABILITY[stage]
      : lead.probability

  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: { stage, probability },
  })

  await touchLead(leadId, {
    kind: 'STAGE_CHANGE',
    body: note
      ? `${STAGE_LABEL[lead.stage]} → ${STAGE_LABEL[stage]}: ${note}`
      : `${STAGE_LABEL[lead.stage]} → ${STAGE_LABEL[stage]}`,
    source: 'SYSTEM',
  })

  return updated
}

/**
 * Follow-ups.
 *
 * A lead on follow-up carries a date and a reason. Setting one is not contact
 * with the customer — so none of these functions touches `lastActivityOn`
 * except `completeFollowUp`, where chasing has actually happened.
 */

const FOLLOW_UP_FIELDS = {
  id: true,
  title: true,
  company: true,
  stage: true,
  contactName: true,
  contactEmail: true,
  followUpOn: true,
  followUpNote: true,
} as const

type FollowUpRow = {
  followUpOn: Date | null
  [key: string]: unknown
}

function withDays<T extends FollowUpRow>(rows: T[], now: Date) {
  return rows.map((row) => ({
    ...row,
    days: followUpDays(row, now),
    due: followUpDue(row, now),
  }))
}

/**
 * What is coming up. Closed leads stay in the list on purpose: "ask again in
 * six months" is a perfectly good reason to put a lost deal on follow-up.
 */
export async function dueFollowUps(withinDays = 14) {
  const now = new Date()
  const until = new Date(now)
  until.setDate(until.getDate() + withinDays)
  until.setHours(23, 59, 59, 999)

  const leads = await prisma.lead.findMany({
    where: { archived: false, followUpOn: { not: null, lte: until } },
    orderBy: { followUpOn: 'asc' },
    select: FOLLOW_UP_FIELDS,
  })
  return withDays(leads, now)
}

/** Put a lead on follow-up, or move the date. */
export async function setFollowUp(leadId: string, on: Date, note?: string | null) {
  return prisma.lead.update({
    where: { id: leadId },
    data: {
      followUpOn: on,
      followUpNote: note ?? null,
      // A new date wants a new reminder.
      followUpNotifiedAt: null,
    },
  })
}

/**
 * Chased up: goes into the history and counts as contact, which is what
 * finally resets the staleness counter. The date comes off.
 */
export async function completeFollowUp(leadId: string, note?: string) {
  const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })
  const reason = note ?? lead.followUpNote
  await touchLead(leadId, {
    kind: 'FOLLOW_UP',
    body: reason ? `Nachgefasst: ${reason}` : 'Nachgefasst',
  })
  return prisma.lead.update({
    where: { id: leadId },
    data: { followUpOn: null, followUpNote: null, followUpNotifiedAt: null },
  })
}

/** Take the follow-up off without writing history — for a wrong date. */
export async function clearFollowUp(leadId: string) {
  return prisma.lead.update({
    where: { id: leadId },
    data: { followUpOn: null, followUpNote: null, followUpNotifiedAt: null },
  })
}

/**
 * Hand out the due follow-ups that have not been announced yet and mark them
 * as announced in the same breath.
 *
 * The marking is what keeps the desktop app from repeating the same reminder
 * every five minutes. Moving the date clears the mark, so a follow-up pushed
 * to next week announces itself again then.
 */
export async function claimDueNotifications() {
  const now = new Date()
  const due = await prisma.lead.findMany({
    where: {
      archived: false,
      followUpOn: { not: null, lte: endOfToday(now) },
      OR: [
        { followUpNotifiedAt: null },
        { followUpNotifiedAt: { lt: prisma.lead.fields.followUpOn } },
      ],
    },
    orderBy: { followUpOn: 'asc' },
    select: FOLLOW_UP_FIELDS,
  })
  if (due.length) {
    await prisma.lead.updateMany({
      where: { id: { in: due.map((lead) => lead.id) } },
      data: { followUpNotifiedAt: now },
    })
  }
  return withDays(due, now)
}

function endOfToday(now: Date): Date {
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  return end
}

/**
 * Pipeline overview: what sits where, what it is worth, what to expect after
 * weighting. The basis for tile, list and MCP tool — so all three agree.
 */
export async function pipelineSummary() {
  const leads = await prisma.lead.findMany({
    where: { archived: false },
    include: { offers: true },
  })

  const open = leads.filter((l) => OPEN_STAGES.includes(l.stage))
  const byStage = OPEN_STAGES.map((stage) => {
    const inStage = open.filter((l) => l.stage === stage)
    return {
      stage,
      label: STAGE_LABEL[stage],
      count: inStage.length,
      valueCents: inStage.reduce((sum, l) => sum + leadValueCents(l), 0),
      weightedCents: inStage.reduce((sum, l) => sum + weightedCents(l), 0),
    }
  })

  const now = new Date()

  const followUpList = leads
    .filter((lead) => lead.followUpOn)
    .sort((a, b) => (a.followUpOn?.getTime() ?? 0) - (b.followUpOn?.getTime() ?? 0))
    .map((lead) => ({
      id: lead.id,
      title: lead.title,
      company: lead.company,
      stage: lead.stage,
      followUpOn: lead.followUpOn,
      followUpNote: lead.followUpNote,
      days: followUpDays(lead, now),
      due: followUpDue(lead, now),
    }))

  const yearStart = new Date(now.getFullYear(), 0, 1)
  const closedThisYear = leads.filter(
    (l) => l.updatedAt >= yearStart && !OPEN_STAGES.includes(l.stage),
  )
  const won = closedThisYear.filter((l) => l.stage === 'WON')

  return {
    openCount: open.length,
    openValueCents: open.reduce((sum, l) => sum + leadValueCents(l), 0),
    weightedCents: open.reduce((sum, l) => sum + weightedCents(l), 0),
    byStage,
    stale: open
      .filter((l) => stalenessDays(l, now) >= 14)
      .sort((a, b) => a.lastActivityAt.getTime() - b.lastActivityAt.getTime())
      .slice(0, 5)
      .map((l) => ({ id: l.id, title: l.title, days: stalenessDays(l, now) })),
    // Straight out of the leads already loaded — the tile and the list must
    // not disagree about what is due.
    followUps: {
      due: followUpList.filter((f) => f.due),
      next: followUpList.filter((f) => !f.due).slice(0, 5),
    },
    wonThisYear: won.length,
    wonValueCents: won.reduce((sum, l) => sum + leadValueCents(l), 0),
    // Win rate over decided deals only — open leads would drag it down for
    // no good reason.
    winRate: closedThisYear.length ? Math.round((won.length / closedThisYear.length) * 100) : null,
  }
}
