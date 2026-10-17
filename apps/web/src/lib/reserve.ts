/**
 * Was die Rücklagenseite außerhalb der Formel braucht.
 *
 * Gerechnet wird in @soloops/shared — hier stehen nur die Monatsnamen und der
 * CSV-Export, also das, was die Jahresdokumentation aus der Anwendung heraus
 * und in ein Archiv bringt, das auch ohne soloops noch lesbar ist.
 */

import type { ReserveLine, ReserveRates } from '@soloops/shared'

export const MONTHS = [
  'Januar',
  'Februar',
  'März',
  'April',
  'Mai',
  'Juni',
  'Juli',
  'August',
  'September',
  'Oktober',
  'November',
  'Dezember',
] as const

export const monthName = (month: number): string => MONTHS[month - 1] ?? String(month)

export type ReserveMonthRow = ReserveLine & {
  month: number
  note: string | null
  /** Was die Rechnungen des Monats hergeben — Vorschlag, kein Wert. */
  invoicedGrossCents: number
}

export type ReserveCost = {
  id: string
  label: string
  monthlyCents: number
  note: string | null
  position: number
}

/** Das Jahr, wie `/api/reserve/:year` es beantwortet. */
export type ReserveYearView = {
  year: number
  /** Falsch, solange für das Jahr nichts eingetragen wurde. */
  exists: boolean
  rates: ReserveRates
  note: string | null
  costs: ReserveCost[]
  costPerMonthCents: number
  months: ReserveMonthRow[]
  total: ReserveLine
}

/** Betrag deutsch, ohne Währungszeichen: `1234.5` wird zu `1234,50`. */
const amount = (cents: number): string => (cents / 100).toFixed(2).replace('.', ',')

/**
 * Das Jahr als CSV, Semikolon getrennt und mit Dezimalkomma — so, wie Excel
 * und Numbers es hier erwarten.
 *
 * Die Sätze stehen als Kopfzeile mit drin: eine Tabelle, aus der nicht
 * hervorgeht, mit welchem Steuersatz sie gerechnet wurde, ist als
 * Dokumentation wertlos.
 */
export function reserveCsv(
  year: number,
  rates: ReserveRates,
  months: ReserveMonthRow[],
  total: ReserveLine,
): string {
  const rows: string[][] = [
    [`Rücklage ${year}`],
    [
      `Umsatzsteuer ${rates.vatRate} %`,
      `Steuersatz ${rates.incomeTaxRate} %`,
      `Skonto ${rates.discountRate} %`,
    ],
    [],
    [
      'Monat',
      'Brutto',
      'Skonto',
      'Umsatzsteuer',
      'Netto',
      'Steuerrücklage',
      'Geschäftskosten',
      'Auszahlung privat',
    ],
    ...months.map((m) => [
      monthName(m.month),
      amount(m.grossCents),
      amount(m.discountCents),
      amount(m.vatCents),
      amount(m.netCents),
      amount(m.reserveCents),
      amount(m.costCents),
      amount(m.payoutCents),
    ]),
    [
      'Summe',
      amount(total.grossCents),
      amount(total.discountCents),
      amount(total.vatCents),
      amount(total.netCents),
      amount(total.reserveCents),
      amount(total.costCents),
      amount(total.payoutCents),
    ],
  ]
  return rows.map((row) => row.join(';')).join('\n')
}
