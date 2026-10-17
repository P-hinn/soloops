/**
 * Was laut Rechnungen im Jahr reingekommen ist, Monat für Monat.
 *
 * Gezählt wird nach Rechnungsdatum und nur, was raus ist — Entwürfe und
 * stornierte Rechnungen sind kein Umsatz. Zwei Seiten lesen das: die
 * Buchhaltung zeigt es als Jahresverlauf, die Rücklagenrechnung bietet es als
 * Vorschlag für den Monatsumsatz an. Dieselbe Abfrage zweimal zu schreiben
 * hieße, dass die beiden Seiten irgendwann verschiedene Umsätze zeigen.
 */

import { prisma } from '../db.js'

export type RevenueMonth = {
  /** 1 bis 12. */
  month: number
  netCents: number
  taxCents: number
  grossCents: number
  count: number
}

export type RevenueYear = {
  year: number
  months: RevenueMonth[]
  totalNetCents: number
  totalTaxCents: number
  totalGrossCents: number
}

export async function revenueByMonth(year: number): Promise<RevenueYear> {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: ['SENT', 'PAID', 'OVERDUE'] },
      issueDate: { gte: new Date(year, 0, 1), lt: new Date(year + 1, 0, 1) },
    },
    select: { issueDate: true, subtotalCents: true, taxCents: true, totalCents: true },
  })

  const months: RevenueMonth[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    netCents: 0,
    taxCents: 0,
    grossCents: 0,
    count: 0,
  }))
  for (const inv of invoices) {
    const m = months[inv.issueDate.getMonth()]
    if (!m) continue
    m.netCents += inv.subtotalCents
    m.taxCents += inv.taxCents
    m.grossCents += inv.totalCents
    m.count += 1
  }

  return {
    year,
    months,
    totalNetCents: months.reduce((s, m) => s + m.netCents, 0),
    totalTaxCents: months.reduce((s, m) => s + m.taxCents, 0),
    totalGrossCents: months.reduce((s, m) => s + m.grossCents, 0),
  }
}
