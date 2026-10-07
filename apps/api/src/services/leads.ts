import type { ActivityKind, LeadStage } from '@prisma/client'
import { prisma } from '../db.js'
import {
  leadValueCents,
  stalenessDays,
  weightedCents,
  OPEN_STAGES,
  STAGE_LABEL,
  STAGE_PROBABILITY,
} from './leadMath.js'

// The pure arithmetic lives in leadMath.ts (no Prisma, so it stays testable)
// and is re-exported here — callers should only need to know one place.
export { leadValueCents, stalenessDays, weightedCents, OPEN_STAGES, STAGE_LABEL, STAGE_PROBABILITY }

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

  // Announced from here rather than from the routes, so a stage change gets
  // the same events whichever way it arrived — interface, MCP server or an
  // automation. The early return above means an unchanged stage announces
  // nothing, which is the point: a save button pressed twice is not an event.
  //
  // Imported lazily: this module is imported by the MCP server and the
  // worker, and the delivery path pulls in the Redis queue behind it.
  const { emitAutomationEvent } = await import('./automationDelivery.js')
  const payload = {
    projectId: updated.projectId,
    path: `/leads/${leadId}`,
    data: {
      id: updated.id,
      title: updated.title,
      stage: updated.stage,
      previousStage: lead.stage,
      company: updated.company,
      contactName: updated.contactName,
      contactEmail: updated.contactEmail,
      valueCents: updated.valueCents,
      currency: updated.currency,
      probability: updated.probability,
      clientId: updated.clientId,
      projectId: updated.projectId,
      lostReason: updated.lostReason,
      note: note ?? null,
    },
  }

  await emitAutomationEvent({ event: 'LEAD_STAGE_CHANGED', ...payload })
  // Won and lost also get their own event. A workflow that only cares about
  // the win should not have to filter every move through the pipeline.
  if (stage === 'WON') await emitAutomationEvent({ event: 'LEAD_WON', ...payload })
  if (stage === 'LOST') await emitAutomationEvent({ event: 'LEAD_LOST', ...payload })

  return updated
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
    wonThisYear: won.length,
    wonValueCents: won.reduce((sum, l) => sum + leadValueCents(l), 0),
    // Win rate over decided deals only — open leads would drag it down for
    // no good reason.
    winRate: closedThisYear.length ? Math.round((won.length / closedThisYear.length) * 100) : null,
  }
}
