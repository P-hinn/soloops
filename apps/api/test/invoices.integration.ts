/**
 * Invoice numbers against a real database.
 *
 * invoices.test.ts covers the formatting; this covers the thing only
 * Postgres can tell you: that twenty invoices issued at the same moment get
 * twenty different numbers, with no gap. The old implementation read
 * `max(number)` and added one, so it could not — and a gap or a duplicate in
 * a sequential invoice series is a legal problem, not a race to shrug at.
 *
 * Not part of `npm test`, which stays database-free. Run it against a
 * throwaway database:
 *
 *     docker run -d --name soloops-invoicetest -e POSTGRES_PASSWORD=test \
 *       -e POSTGRES_USER=test -e POSTGRES_DB=invoicetest -p 55433:5432 postgres:17-alpine
 *     DATABASE_URL="postgresql://test:test@localhost:55433/invoicetest?schema=public" \
 *       npx prisma migrate deploy --schema prisma/schema.prisma
 *     npm -w @soloops/api run test:invoices
 */
import { dbRaw, prisma } from '../src/db.js'
import { nextInvoiceNumber } from '../src/services/invoices.js'

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

// The same guard as sync.integration.ts: this test empties tables.
if (!process.env.DATABASE_URL?.includes('invoicetest')) {
  console.error(
    'Refuse: DATABASE_URL muss auf eine Wegwerf-Datenbank zeigen (Name enthaelt "invoicetest").\n' +
      'Dieser Test leert Tabellen.',
  )
  process.exit(1)
}

// Children before parents, over the raw client so the sync log stays out of
// it — the op log has nothing to do with what is being tested here.
async function reset() {
  await dbRaw.invoiceItem.deleteMany({})
  await dbRaw.invoice.deleteMany({})
  await dbRaw.invoiceSequence.deleteMany({})
  await dbRaw.client.deleteMany({})
}

await reset()

const client = await dbRaw.client.create({
  data: { name: 'Testkunde', paymentTermDays: 14 },
})

/** One invoice, exactly the way routes/invoices.ts writes it. */
function issue(year: number) {
  return prisma.$transaction(async (tx) =>
    tx.invoice.create({
      data: {
        number: await nextInvoiceNumber(tx, 'RE', year),
        clientId: client.id,
        issueDate: new Date(`${year}-06-01T10:00:00Z`),
        dueDate: new Date(`${year}-06-15T10:00:00Z`),
      },
      select: { number: true },
    }),
  )
}

// --- Twenty at once ---------------------------------------------------------

const issued = await Promise.all(Array.from({ length: 20 }, () => issue(2026)))
const numbers = issued.map((i) => i.number).sort()

check('zwanzig gleichzeitige Rechnungen ergeben zwanzig Nummern', numbers.length, 20)
check('und keine davon doppelt', new Set(numbers).size, 20)
check(
  'und sie sind lueckenlos von 1 bis 20',
  numbers,
  Array.from({ length: 20 }, (_, i) => `RE-2026-${String(i + 1).padStart(4, '0')}`),
)

const counter = await dbRaw.invoiceSequence.findUnique({ where: { year: 2026 } })
check('der Zaehler steht danach auf 20', counter?.last, 20)

// --- A new year starts at one -----------------------------------------------

const next = await issue(2027)
check('das neue Jahr beginnt wieder bei eins', next.number, 'RE-2027-0001')
check(
  'und das alte Jahr bleibt, wo es war',
  (await dbRaw.invoiceSequence.findUnique({ where: { year: 2026 } }))?.last,
  20,
)

// --- A rolled back invoice must not burn a number ---------------------------

const before = (await dbRaw.invoiceSequence.findUnique({ where: { year: 2026 } }))?.last
try {
  await prisma.$transaction(async (tx) => {
    await nextInvoiceNumber(tx, 'RE', 2026)
    throw new Error('abbruch')
  })
} catch {
  // expected
}
check(
  'eine abgebrochene Rechnung verbrennt keine Nummer',
  (await dbRaw.invoiceSequence.findUnique({ where: { year: 2026 } }))?.last,
  before,
)

const after = await issue(2026)
check('die naechste Nummer folgt direkt auf die letzte', after.number, 'RE-2026-0021')

await reset()
console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
await dbRaw.$disconnect()
if (fail > 0) process.exit(1)
