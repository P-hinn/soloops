/**
 * Die Rücklagenrechnung: Umsatz rein, Auszahlung raus.
 *
 * Eine Dokumentation für einen selbst, kein Steuerbescheid. Eingetragen wird
 * pro Monat genau eine Zahl — der Bruttoumsatz —, alles andere fällt aus den
 * Sätzen des Jahres heraus. Deshalb liegt hier auch kein einziges Ergebnis in
 * der Datenbank: wer im März den Steuersatz korrigiert, will die korrigierte
 * Rechnung für das ganze Jahr sehen und nicht zwölf eingefrorene Zahlen aus
 * der Zeit davor.
 *
 * Gerechnet wird in @soloops/shared, damit die Oberfläche beim Tippen
 * dieselbe Formel benutzt wie die API beim Speichern.
 */

import {
  DEFAULT_RESERVE_RATES,
  reserveLine,
  sumReserveLines,
  type ReserveLine,
  type ReserveRates,
} from '@soloops/shared'
import { prisma } from '../db.js'
import { invoiceDefaults } from '../settings.js'
import { revenueByMonth } from './revenue.js'

export type ReserveCostRow = {
  id: string
  label: string
  monthlyCents: number
  note: string | null
  position: number
}

export type ReserveMonthRow = ReserveLine & {
  month: number
  note: string | null
  /** Was die Rechnungen dieses Monats hergeben — als Vorschlag, nie gesetzt. */
  invoicedGrossCents: number
}

export type ReserveYearView = {
  year: number
  /** Falsch, solange für das Jahr noch nichts eingetragen wurde. */
  exists: boolean
  rates: ReserveRates
  note: string | null
  costs: ReserveCostRow[]
  costPerMonthCents: number
  months: ReserveMonthRow[]
  total: ReserveLine
}

/**
 * Die Sätze, mit denen ein neues Jahr anfängt.
 *
 * Das zuletzt angelegte Jahr gewinnt — wer sich einmal auf 35 % festgelegt
 * hat, will das nicht jeden Januar neu eintragen. Erst wenn es noch gar kein
 * Jahr gibt, kommen Umsatzsteuersatz und Kleinunternehmerregelung aus den
 * Einstellungen.
 */
export async function defaultRates(before?: number): Promise<ReserveRates> {
  const previous = await prisma.reserveYear.findFirst({
    where: before ? { year: { lt: before } } : {},
    orderBy: { year: 'desc' },
  })
  if (previous) {
    return {
      vatRate: previous.vatRate,
      incomeTaxRate: previous.incomeTaxRate,
      discountRate: previous.discountRate,
    }
  }
  const invoice = await invoiceDefaults()
  return {
    ...DEFAULT_RESERVE_RATES,
    vatRate: invoice.smallBusiness ? 0 : invoice.taxRate,
  }
}

/**
 * Das Jahr, wie es gespeichert ist — und wenn es das noch nicht ist, legt es
 * diese Funktion an: mit den Sätzen und den Kostenposten des Vorjahres.
 *
 * Nur Schreibzugriffe gehen hier durch. Ein Jahr bloß anzusehen darf keine
 * Zeile anlegen, sonst steht im Jahreswechsler irgendwann jedes Jahr, durch
 * das jemand einmal geblättert hat.
 */
export async function ensureYear(year: number) {
  const existing = await prisma.reserveYear.findUnique({ where: { year } })
  if (existing) return existing

  const previous = await prisma.reserveYear.findFirst({
    where: { year: { lt: year } },
    orderBy: { year: 'desc' },
    include: { costs: { orderBy: { position: 'asc' } } },
  })
  const rates = await defaultRates(year)

  return prisma.reserveYear.create({
    data: {
      year,
      ...rates,
      costs: previous
        ? {
            create: previous.costs.map((c) => ({
              label: c.label,
              monthlyCents: c.monthlyCents,
              note: c.note,
              position: c.position,
            })),
          }
        : undefined,
    },
  })
}

/** Das ganze Jahr, durchgerechnet — die einzige Leseoperation der Oberfläche. */
export async function readYear(year: number): Promise<ReserveYearView> {
  const [stored, rates, revenue] = await Promise.all([
    prisma.reserveYear.findUnique({
      where: { year },
      include: {
        costs: { orderBy: [{ position: 'asc' }, { label: 'asc' }] },
        months: true,
      },
    }),
    defaultRates(year),
    revenueByMonth(year),
  ])

  const effective: ReserveRates = stored
    ? {
        vatRate: stored.vatRate,
        incomeTaxRate: stored.incomeTaxRate,
        discountRate: stored.discountRate,
      }
    : rates

  const costs = (stored?.costs ?? []).map((c) => ({
    id: c.id,
    label: c.label,
    monthlyCents: c.monthlyCents,
    note: c.note,
    position: c.position,
  }))
  const costPerMonthCents = costs.reduce((sum, c) => sum + c.monthlyCents, 0)

  const entered = new Map((stored?.months ?? []).map((m) => [m.month, m]))
  const months: ReserveMonthRow[] = Array.from({ length: 12 }, (_, i) => {
    const month = i + 1
    const row = entered.get(month)
    return {
      month,
      note: row?.note ?? null,
      invoicedGrossCents: revenue.months[i]?.grossCents ?? 0,
      ...reserveLine(row?.grossCents ?? 0, costPerMonthCents, effective),
    }
  })

  return {
    year,
    exists: Boolean(stored),
    rates: effective,
    note: stored?.note ?? null,
    costs,
    costPerMonthCents,
    months,
    total: sumReserveLines(months),
  }
}

/**
 * Die Jahre, die es gibt, mit ihrer Auszahlung — für den Jahreswechsler.
 *
 * Das laufende Jahr steht immer dabei, auch wenn darin noch nichts eingetragen
 * wurde: es ist das, was man sucht, wenn man die Seite aufmacht.
 */
export async function listYears(
  today = new Date(),
): Promise<{ year: number; payoutCents: number }[]> {
  const years = await prisma.reserveYear.findMany({
    orderBy: { year: 'desc' },
    include: { costs: true, months: true },
  })

  const rows = years.map((y) => {
    const costPerMonthCents = y.costs.reduce((sum, c) => sum + c.monthlyCents, 0)
    const rates: ReserveRates = {
      vatRate: y.vatRate,
      incomeTaxRate: y.incomeTaxRate,
      discountRate: y.discountRate,
    }
    const lines = Array.from({ length: 12 }, (_, i) => {
      const month = y.months.find((m) => m.month === i + 1)
      return reserveLine(month?.grossCents ?? 0, costPerMonthCents, rates)
    })
    return { year: y.year, payoutCents: sumReserveLines(lines).payoutCents }
  })

  const current = today.getFullYear()
  if (!rows.some((r) => r.year === current)) rows.unshift({ year: current, payoutCents: 0 })
  return rows.sort((a, b) => b.year - a.year)
}
