import type { ActivityKind, Lead, LeadStage, Offer } from '@prisma/client'
import { prisma } from '../db.js'

/**
 * Vertriebslogik, die API, Worker und MCP-Server teilen.
 */

/** Standardwahrscheinlichkeit je Stufe — Vorschlag beim Stufenwechsel. */
export const STAGE_PROBABILITY: Record<LeadStage, number> = {
  NEW: 10,
  QUALIFIED: 25,
  PROPOSAL: 50,
  NEGOTIATION: 75,
  WON: 100,
  LOST: 0,
}

export const STAGE_LABEL: Record<LeadStage, string> = {
  NEW: 'Neu',
  QUALIFIED: 'Qualifiziert',
  PROPOSAL: 'Angebot',
  NEGOTIATION: 'Verhandlung',
  WON: 'Gewonnen',
  LOST: 'Verloren',
}

export const OPEN_STAGES: LeadStage[] = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION']

/**
 * Was ist der Lead wert?
 *
 * Ein herausgeschicktes Angebot ist belastbarer als eine Schätzung vom
 * Erstkontakt — deshalb schlägt die Angebotssumme den eingetragenen Wert,
 * sobald es eins gibt. Angenommen > verschickt > Entwurf.
 */
export function leadValueCents(lead: Lead & { offers?: Offer[] }): number {
  const offers = lead.offers ?? []
  const accepted = offers.find((o) => o.status === 'ACCEPTED')
  if (accepted) return accepted.amountCents

  const sent = offers
    .filter((o) => o.status === 'SENT')
    .sort((a, b) => (b.sentOn?.getTime() ?? 0) - (a.sentOn?.getTime() ?? 0))[0]
  if (sent) return sent.amountCents

  return lead.valueCents ?? 0
}

/** Gewichteter Wert: Summe mal deiner Wahrscheinlichkeit. */
export function weightedCents(lead: Lead & { offers?: Offer[] }): number {
  return Math.round((leadValueCents(lead) * lead.probability) / 100)
}

/** Tage ohne jede Aktivität. Treibt die „liegt zu lange still"-Anzeige. */
export function stalenessDays(lead: Lead, now = new Date()): number {
  return Math.floor((now.getTime() - lead.lastActivityAt.getTime()) / 86_400_000)
}

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
