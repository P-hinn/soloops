import type { LeadStage } from '@prisma/client'

/**
 * Pure sales arithmetic — deliberately without a Prisma or env import, so it
 * can be tested without a running database.
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
 * What is the lead worth?
 *
 * An offer that has gone out is more reliable than a guess from the first
 * call — so the offer amount beats the recorded value as soon as there is
 * one. Accepted > sent > your own estimate. A draft does not count: it has
 * not left the building.
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

/** Weighted value: amount times your own probability. */
export function weightedCents(lead: LeadLike): number {
  return Math.round((leadValueCents(lead) * lead.probability) / 100)
}

/** Days without any activity. Drives the "gone quiet for too long" flag. */
export function stalenessDays(lead: { lastActivityAt: Date }, now = new Date()): number {
  return Math.floor((now.getTime() - lead.lastActivityAt.getTime()) / 86_400_000)
}
