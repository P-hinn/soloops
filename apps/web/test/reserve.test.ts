import { reserveLine, sumReserveLines } from '@soloops/shared'
import { centsToEuro, euroToCents } from '../src/lib/money.js'
import { monthName, reserveCsv } from '../src/lib/reserve.js'

/**
 * Eingabefeld und Export.
 *
 * Gerechnet wird woanders (packages/core/test/reserve.test.ts hält die Formel
 * gegen die Tabelle, aus der sie stammt). Hier stehen die zwei Ränder: was
 * passiert, wenn jemand "12.554,50" tippt, und was in der CSV landet, die als
 * Jahresdokumentation weggelegt wird.
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

// --- Was im Feld steht -----------------------------------------------------

check('deutscher Betrag mit Tausenderpunkt', euroToCents('12.554,50'), 1_255_450)
check('englische Schreibweise', euroToCents('12554.50'), 1_255_450)
check('ohne Nachkommastellen', euroToCents('1200'), 120_000)
check('mit Währungszeichen und Leerzeichen', euroToCents(' 95,50 € '), 9550)
check('leer ist nicht null, sondern nichts', euroToCents('   '), null)
check('Text ist kein Betrag', euroToCents('viel'), null)
check('negativ bleibt negativ', euroToCents('-250,00'), -25_000)
check('Cent werden gerundet', euroToCents('0,005'), 1)
check('zurück ins Feld', centsToEuro(1_255_450), '12554.50')
check('nichts hinterlegt bleibt leer', centsToEuro(null), '')
check('null Euro sind nicht nichts', centsToEuro(0), '0.00')

// --- Die CSV ---------------------------------------------------------------

check('Monatsnamen ausgeschrieben', [monthName(1), monthName(12)], ['Januar', 'Dezember'])

const rates = { vatRate: 19, incomeTaxRate: 35, discountRate: 0 }
const months = [1, 2].map((month) => ({
  month,
  ...reserveLine(month === 1 ? 1_255_450 : 0, 50_000, rates),
}))
const csv = reserveCsv(2026, rates, months, sumReserveLines(months))
const lines = csv.split('\n')

check('die Sätze stehen im Kopf', lines[1], 'Umsatzsteuer 19 %;Steuersatz 35 %;Skonto 0 %')
check(
  'eine Zeile je Monat, mit Dezimalkomma',
  lines[4],
  'Januar;12554,50;0,00;2004,50;10550,00;3692,50;500,00;6357,50',
)
check(
  'der leere Monat steht trotzdem drin',
  lines[5],
  'Februar;0,00;0,00;0,00;0,00;0,00;500,00;-500,00',
)
check('und zuletzt die Jahressumme', lines[6]?.startsWith('Summe;12554,50'), true)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
