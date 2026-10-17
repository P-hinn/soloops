/**
 * Was vom Umsatz übrig bleibt — die Rechnung hinter der Rücklage.
 *
 * Der Monat kommt brutto rein, wie er auf der Rechnung steht, und geht in
 * vier Teile auseinander: Umsatzsteuer, Einkommen-/Gewerbesteuer-Rücklage,
 * Geschäftskosten und das, was privat übrig bleibt. Gerechnet wird in Cent
 * und nur an einer Stelle: die API schreibt die Monatswerte, die Oberfläche
 * rechnet beim Tippen mit — zwei Implementierungen derselben Formel wären
 * zwei Ergebnisse, und die Zahl, der hier geglaubt werden soll, ist genau
 * eine.
 *
 * Die Reihenfolge ist die, die das Finanzamt auch nimmt: erst Skonto, dann
 * die Umsatzsteuer **aus** dem Bruttobetrag herausrechnen (nicht draufschlagen),
 * und die Einkommensteuer-Rücklage vom Netto — die Umsatzsteuer war nie
 * Einkommen.
 */

import { z } from 'zod'

/** Die drei Sätze, die ein Jahr beschreiben — in Prozent, nicht als Faktor. */
export type ReserveRates = {
  /** Umsatzsteuer. 0 bei Kleinunternehmern (§19 UStG). */
  vatRate: number
  /** Einkommen- und Gewerbesteuer zusammen — der Satz, den du zurücklegst. */
  incomeTaxRate: number
  /** Skonto, das du deinen Kunden gewährst. Meist 0. */
  discountRate: number
}

export const DEFAULT_RESERVE_RATES: ReserveRates = {
  vatRate: 19,
  incomeTaxRate: 35,
  discountRate: 0,
}

/** Ein Monat, komplett aufgeschlüsselt. Alles in Cent. */
export type ReserveLine = {
  /** Was fakturiert wurde, inklusive Umsatzsteuer. */
  grossCents: number
  discountCents: number
  afterDiscountCents: number
  /** Die Umsatzsteuer darin — durchlaufender Posten, gehört dem Finanzamt. */
  vatCents: number
  netCents: number
  /** Netto mal Steuersatz: was für die Einkommensteuer liegen bleibt. */
  reserveCents: number
  /** Umsatzsteuer plus Rücklage — der Betrag, der dir nicht gehört. */
  setAsideCents: number
  costCents: number
  /** Netto minus Rücklage minus Kosten. Kann negativ werden. */
  payoutCents: number
}

const pct = (cents: number, rate: number) => Math.round(cents * (rate / 100))

/**
 * Ein Monat (oder eine einzelne Rechnung) durchgerechnet.
 *
 * `costCents` kommt von außen, weil die Kosten am Jahr hängen und nicht am
 * Umsatz: ein Monat ohne Umsatz hat trotzdem Miete.
 */
export function reserveLine(
  grossCents: number,
  costCents: number,
  rates: ReserveRates,
): ReserveLine {
  const discountCents = pct(grossCents, rates.discountRate)
  const afterDiscountCents = grossCents - discountCents
  // Herausrechnen, nicht draufschlagen — und das Netto ist der gerundete
  // Teil, die Umsatzsteuer der Rest. So ergeben die beiden zusammen wieder
  // exakt den Bruttobetrag, auch wenn es auf einen Cent ankommt.
  const netCents = Math.round(afterDiscountCents / (1 + rates.vatRate / 100))
  const vatCents = afterDiscountCents - netCents
  const reserveCents = pct(netCents, rates.incomeTaxRate)

  return {
    grossCents,
    discountCents,
    afterDiscountCents,
    vatCents,
    netCents,
    reserveCents,
    setAsideCents: vatCents + reserveCents,
    costCents,
    payoutCents: netCents - reserveCents - costCents,
  }
}

/** Die Jahressumme: Spalte für Spalte addiert, nicht neu gerechnet. */
export function sumReserveLines(lines: ReserveLine[]): ReserveLine {
  return lines.reduce(
    (total, line) => ({
      grossCents: total.grossCents + line.grossCents,
      discountCents: total.discountCents + line.discountCents,
      afterDiscountCents: total.afterDiscountCents + line.afterDiscountCents,
      vatCents: total.vatCents + line.vatCents,
      netCents: total.netCents + line.netCents,
      reserveCents: total.reserveCents + line.reserveCents,
      setAsideCents: total.setAsideCents + line.setAsideCents,
      costCents: total.costCents + line.costCents,
      payoutCents: total.payoutCents + line.payoutCents,
    }),
    {
      grossCents: 0,
      discountCents: 0,
      afterDiscountCents: 0,
      vatCents: 0,
      netCents: 0,
      reserveCents: 0,
      setAsideCents: 0,
      costCents: 0,
      payoutCents: 0,
    },
  )
}

// ---------------------------------------------------------------------------
// Was die API annimmt
// ---------------------------------------------------------------------------

const rate = z.number().min(0).max(100)

export const reserveYearInput = z.object({
  vatRate: rate,
  incomeTaxRate: rate,
  discountRate: rate,
  note: z.string().max(4000).nullish(),
})

export const reserveCostInput = z.object({
  label: z.string().min(1).max(80),
  monthlyCents: z.number().int().min(0),
  note: z.string().max(400).nullish(),
  position: z.number().int().min(0).max(999).optional(),
})

export const reserveMonthInput = z.object({
  /** Darf negativ sein: eine Gutschrift im Monat ist kein Tippfehler. */
  grossCents: z.number().int(),
  note: z.string().max(400).nullish(),
})

export const yearParam = z.object({ year: z.coerce.number().int().min(2000).max(2100) })
export const yearMonthParam = yearParam.extend({
  month: z.coerce.number().int().min(1).max(12),
})

export type ReserveYearInput = z.infer<typeof reserveYearInput>
export type ReserveCostInput = z.infer<typeof reserveCostInput>
export type ReserveMonthInput = z.infer<typeof reserveMonthInput>
