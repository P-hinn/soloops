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

// Die reine Rechnung liegt in leadMath.ts (ohne Prisma, damit testbar) und
// wird hier mit durchgereicht — Aufrufer sollen nur einen Ort kennen müssen.
export { leadValueCents, stalenessDays, weightedCents, OPEN_STAGES, STAGE_LABEL, STAGE_PROBABILITY }

/**
 * Vertriebslogik, die API, Worker und MCP-Server teilen.
 */

/**
 * Aktivität protokollieren und den Lead als „angefasst" markieren.
 *
 * Beides gehört zusammen: ein Verlaufseintrag ohne aktualisiertes
 * `lastActivityAt` würde den Lead weiter als liegengeblieben anzeigen.
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

  // Eine nachgetragene alte Mail darf den Lead nicht künstlich frisch machen.
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    select: { lastActivityAt: true },
  })
  if (occurredAt > lead.lastActivityAt) {
    await prisma.lead.update({ where: { id: leadId }, data: { lastActivityAt: occurredAt } })
  }
}

/**
 * Stufe wechseln, mit Verlaufseintrag und passender Wahrscheinlichkeit.
 * Eine selbst gesetzte Wahrscheinlichkeit wird nur beim Abschluss überschrieben.
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
 * Pipeline-Überblick: was liegt wo, was ist es wert, was ist gewichtet zu
 * erwarten. Basis für Kachel, Liste und MCP-Tool — damit alle dasselbe sagen.
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
    // Trefferquote nur über tatsächlich Entschiedenes — offene Leads würden
    // sie künstlich drücken.
    winRate: closedThisYear.length ? Math.round((won.length / closedThisYear.length) * 100) : null,
  }
}
