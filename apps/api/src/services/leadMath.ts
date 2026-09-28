import type { LeadStage } from '@prisma/client'

/**
 * Reine Vertriebsrechnung — bewusst ohne Prisma- und env-Import, damit sie
 * sich ohne laufende Datenbank testen lässt.
 */

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

type OfferLike = { status: string; amountCents: number; sentOn: Date | null }
type LeadLike = { valueCents: number | null; probability: number; offers?: OfferLike[] }

/**
 * Was ist der Lead wert?
 *
 * Ein herausgeschicktes Angebot ist belastbarer als eine Schätzung vom
 * Erstkontakt — deshalb schlägt die Angebotssumme den eingetragenen Wert,
 * sobald es eins gibt. Angenommen > verschickt > eigene Schätzung. Ein
 * Entwurf zählt nicht: der ist noch nicht raus.
 */
export function leadValueCents(lead: LeadLike): number {
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
export function weightedCents(lead: LeadLike): number {
  return Math.round((leadValueCents(lead) * lead.probability) / 100)
}

/** Tage ohne jede Aktivität. Treibt die „liegt zu lange still"-Anzeige. */
export function stalenessDays(lead: { lastActivityAt: Date }, now = new Date()): number {
  return Math.floor((now.getTime() - lead.lastActivityAt.getTime()) / 86_400_000)
}
