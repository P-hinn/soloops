import { invoiceNumber } from '../src/services/invoices.js'

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

// ---------------------------------------------------------------------------
// The number
//
// Fixed width is not cosmetic: it is what makes the text of a number sort
// like the number, which half of the interface relies on.
// ---------------------------------------------------------------------------

check('die erste Nummer des Jahres', invoiceNumber('RE', 2026, 1), 'RE-2026-0001')
check('vierstellig aufgefuellt', invoiceNumber('RE', 2026, 7), 'RE-2026-0007')
check('dreistellig bleibt vierstellig', invoiceNumber('RE', 2026, 142), 'RE-2026-0142')

check(
  'ab zehntausend wird die Nummer laenger, nicht falsch',
  invoiceNumber('RE', 2026, 10_000),
  'RE-2026-10000',
)

check(
  'sortiert als Text wie als Zahl',
  [1, 2, 10, 99, 100].map((n) => invoiceNumber('RE', 2026, n)).sort(),
  ['RE-2026-0001', 'RE-2026-0002', 'RE-2026-0010', 'RE-2026-0099', 'RE-2026-0100'],
)

check('ein eigenes Praefix bleibt stehen', invoiceNumber('INV', 2027, 3), 'INV-2027-0003')

// A prefix with a dash in it is why the migration reads the sequence off the
// end of the number instead of splitting on the third dash.
check(
  'ein Praefix mit Bindestrich bleibt lesbar',
  invoiceNumber('RE-PN', 2026, 4),
  'RE-PN-2026-0004',
)

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
