import { DEFAULT_RESERVE_RATES, reserveLine, sumReserveLines } from '@soloops/shared'

/**
 * Die Rücklagenformel, gegen die Tabelle gerechnet, aus der sie stammt.
 *
 * Die Zahlen unten sind echte Zeilen aus der Numbers-Datei, mit der das
 * vorher gerechnet wurde (19 % Umsatzsteuer, 35 % Einkommen + Gewerbe). Sie
 * stehen hier, weil der häufigste Fehler an so einer Rechnung nicht das
 * Runden ist, sondern die Richtung: Umsatzsteuer aus dem Brutto
 * **herausrechnen** statt sie draufzuschlagen, und die Rücklage vom Netto
 * statt vom Brutto nehmen. Beides fällt nur auf, wenn eine fremde Quelle
 * dagegen hält.
 */

let pass = 0,
  fail = 0

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
  if (!ok) {
    console.log('        erwartet:', JSON.stringify(want))
    console.log('        bekommen:', JSON.stringify(got))
  }
}

const RATES = { vatRate: 19, incomeTaxRate: 35, discountRate: 0 }
const euro = (cents: number) => cents / 100

// --- Die Zeilen aus der Tabelle -------------------------------------------

const line = reserveLine(1_255_450, 0, RATES)
check('Netto aus 12.554,50 brutto', euro(line.netCents), 10_550)
check('Umsatzsteuer darin', euro(line.vatCents), 2004.5)
check('Rücklage auf das Netto', euro(line.reserveCents), 3692.5)
check('was dem Finanzamt gehört', euro(line.setAsideCents), 5697)
check('Brutto bleibt die Summe seiner Teile', line.netCents + line.vatCents, line.grossCents)

// Krumme Beträge: in der Tabelle 1073,899… — gerundet wird auf den Cent, und
// der Rest geht in die Umsatzsteuer, damit nichts verschwindet.
const krumm = reserveLine(672_600, 0, RATES)
check('krummes Netto', euro(krumm.netCents), 5652.1)
check('krumme Umsatzsteuer', euro(krumm.vatCents), 1073.9)
check('krumme Rücklage', euro(krumm.reserveCents), 1978.24)
check('auch krumm bleibt die Summe exakt', krumm.netCents + krumm.vatCents, 672_600)

// --- Skonto, Kosten, Kleinunternehmer -------------------------------------

const skonto = reserveLine(1_000_000, 0, { ...RATES, discountRate: 2 })
check('Skonto geht vor der Umsatzsteuer ab', euro(skonto.discountCents), 200)
check('und die Steuer rechnet auf dem Rest', euro(skonto.afterDiscountCents), 9800)

const klein = reserveLine(500_000, 0, { ...RATES, vatRate: 0 })
check('ohne Umsatzsteuer ist brutto gleich netto', klein.netCents, 500_000)
check('und es geht keine Umsatzsteuer ans Amt', klein.vatCents, 0)

const kosten = reserveLine(1_190_000, 150_000, RATES)
check('Kosten gehen vom Netto ab', euro(kosten.payoutCents), 10_000 - 3500 - 1500)

const leer = reserveLine(0, 150_000, RATES)
check('ein Monat ohne Umsatz hat trotzdem Kosten', euro(leer.payoutCents), -1500)

check('Standardsätze sind 19/35/0', DEFAULT_RESERVE_RATES, {
  vatRate: 19,
  incomeTaxRate: 35,
  discountRate: 0,
})

// --- Das Jahr --------------------------------------------------------------

const jahr = sumReserveLines([line, krumm, leer])
check(
  'die Jahressumme addiert die Spalten',
  [jahr.grossCents, jahr.netCents, jahr.payoutCents],
  [
    line.grossCents + krumm.grossCents,
    line.netCents + krumm.netCents,
    line.payoutCents + krumm.payoutCents + leer.payoutCents,
  ],
)
check('ein leeres Jahr ist überall null', sumReserveLines([]).payoutCents, 0)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
