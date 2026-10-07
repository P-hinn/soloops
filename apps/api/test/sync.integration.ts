/**
 * The sync against a real database.
 *
 * sync.test.ts covers the decisions; this covers the things only Postgres can
 * tell you — that the Prisma hook really intercepts every write shape, that a
 * cascade shows up in the log, and that applying a remote op does not bounce
 * back as a local one.
 *
 * Not part of `npm test`, which stays database-free. Run it against a
 * throwaway database:
 *
 *     docker run -d --name soloops-synctest -e POSTGRES_PASSWORD=test \
 *       -e POSTGRES_USER=test -e POSTGRES_DB=synctest -p 55432:5432 postgres:17-alpine
 *     DATABASE_URL="postgresql://test:test@localhost:55432/synctest?schema=public" \
 *       npx prisma db push --schema prisma/schema.prisma
 *     npm -w @soloops/api run test:sync
 */

import { dbRaw, initSync, prisma } from '../src/db.js'
import { format } from '../src/services/hlc.js'
import { applyOps } from '../src/services/syncApply.js'
import { hostDevice } from '../src/services/syncLog.js'
import type { IncomingOp } from '../src/services/syncMerge.js'

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

if (!process.env.DATABASE_URL?.includes('synctest')) {
  console.error(
    'Refuse: DATABASE_URL muss auf eine Wegwerf-Datenbank zeigen (Name enthaelt "synctest").\n' +
      'Dieser Test leert Tabellen.',
  )
  process.exit(1)
}

// --- A clean slate ---------------------------------------------------------
// Order matters: children before parents.
await dbRaw.syncOp.deleteMany({})
await dbRaw.actionItem.deleteMany({})
await dbRaw.note.deleteMany({})
await dbRaw.meeting.deleteMany({})
await dbRaw.timeEntry.deleteMany({})
await dbRaw.lead.deleteMany({})
await dbRaw.calendarEvent.deleteMany({})
await dbRaw.project.deleteMany({})
await dbRaw.client.deleteMany({})
await dbRaw.syncDevice.deleteMany({})
await dbRaw.appSetting.deleteMany({ where: { key: { startsWith: 'sync.' } } })

await initSync('api')
const HOST = hostDevice()
const PHONE = 'phone-test-device'

const opsFor = (entity: string, entityId: string) =>
  dbRaw.syncOp.findMany({
    where: { entity, entityId },
    orderBy: { hlc: 'asc' },
    select: { deviceId: true, op: true, fields: true, patch: true, hlc: true },
  })

/**
 * The phone's stamps hang off real time, not off a round number in 2033.
 * With a far-future baseline every phone op would be newer than everything
 * the Mac writes, and the conflict tests below would pass without testing
 * anything.
 */
const NOW = Date.now()

let seq = 0
const phoneOp = (over: Partial<IncomingOp> & { millis: number }): IncomingOp => ({
  deviceId: PHONE,
  seq: ++seq,
  hlc: format({ millis: over.millis, counter: 0 }, PHONE),
  entity: 'ActionItem',
  entityId: 'x',
  op: 'upsert',
  ...over,
})

// ---------------------------------------------------------------------------
// The hook sees local writes
// ---------------------------------------------------------------------------

const client = await prisma.client.create({ data: { name: 'ACME GmbH', city: 'Koeln' } })

check(
  'ein create landet als ein Op unter diesem Geraet',
  (await opsFor('Client', client.id)).map((o) => ({ device: o.deviceId, op: o.op })),
  [{ device: HOST, op: 'upsert' }],
)

check(
  'ein create beansprucht die ganze Zeile',
  (await opsFor('Client', client.id))[0]?.fields.includes('name'),
  true,
)

await prisma.client.update({ where: { id: client.id }, data: { city: 'Bonn' } })

check(
  'ein update beansprucht nur das angefasste Feld',
  (await opsFor('Client', client.id)).at(-1)?.fields,
  ['city'],
)

check(
  'der Patch traegt den Wert, der wirklich gelandet ist',
  (await opsFor('Client', client.id)).at(-1)?.patch,
  { city: 'Bonn' },
)

const project = await prisma.project.create({
  data: { key: 'ACME-APP', name: 'App', clientId: client.id },
})

// ---------------------------------------------------------------------------
// Applying a remote op
// ---------------------------------------------------------------------------

const remoteItemId = 'remote-item-1'
let results = await applyOps([
  phoneOp({
    millis: NOW - 120_000,
    entity: 'ActionItem',
    entityId: remoteItemId,
    patch: { title: 'Rueckruf Mueller', done: false, projectId: project.id },
  }),
])

check(
  'ein Op vom Telefon wird angewandt',
  results.map((r) => r.status),
  ['applied'],
)

check(
  'die Zeile ist wirklich da',
  (await dbRaw.actionItem.findUnique({ where: { id: remoteItemId } }))?.title,
  'Rueckruf Mueller',
)

// The echo test. If the hook had logged this write as local, there would be a
// second op here under the host's id, and the two devices would trade it back
// and forth until one of them ran out of battery.
check(
  'das Anwenden erzeugt kein Echo unter diesem Geraet',
  (await opsFor('ActionItem', remoteItemId)).map((o) => o.deviceId),
  [PHONE],
)

check(
  'ein erneut geliefertes Op aendert nichts',
  (
    await applyOps([
      phoneOp({
        millis: NOW - 120_000,
        seq: 1,
        entity: 'ActionItem',
        entityId: remoteItemId,
        patch: { title: 'Rueckruf Mueller', done: false, projectId: project.id },
      }),
    ])
  ).map((r) => r.status),
  ['skipped'],
)

check(
  'und hinterlaesst auch keinen zweiten Log-Eintrag',
  (await opsFor('ActionItem', remoteItemId)).length,
  1,
)

// ---------------------------------------------------------------------------
// A real conflict, through the database
// ---------------------------------------------------------------------------

// The Mac changes the title now, so its stamp sits at roughly NOW. The two
// phone ops below are a minute older: one touches the same field and has to
// lose, the other touches a different field and has to win.
await prisma.actionItem.update({ where: { id: remoteItemId }, data: { title: 'Rueckruf Meier' } })

results = await applyOps([
  phoneOp({
    millis: NOW - 60_000,
    entity: 'ActionItem',
    entityId: remoteItemId,
    patch: { title: 'Rueckruf vom Telefon' },
  }),
  phoneOp({
    millis: NOW - 59_000,
    entity: 'ActionItem',
    entityId: remoteItemId,
    patch: { done: true },
  }),
])

check(
  'das Telefon verliert den Titel und gewinnt das Haekchen',
  results.map((r) => r.status),
  ['skipped', 'applied'],
)

const merged = await dbRaw.actionItem.findUnique({ where: { id: remoteItemId } })
check('der Titel vom Mac bleibt stehen', merged?.title, 'Rueckruf Meier')
check('das Haekchen vom Telefon bleibt stehen', merged?.done, true)

check(
  'der verlorene Schreibversuch steht trotzdem im Log',
  (await opsFor('ActionItem', remoteItemId)).filter((o) => o.deviceId === PHONE).length,
  3,
)

// ---------------------------------------------------------------------------
// What the database does on its own
// ---------------------------------------------------------------------------

const event = await prisma.calendarEvent.create({
  data: {
    title: 'Jour fixe',
    startsAt: new Date('2026-10-06T09:00:00Z'),
    endsAt: new Date('2026-10-06T10:00:00Z'),
  },
})
const meeting = await prisma.meeting.create({
  data: { title: 'Jour fixe', startsAt: new Date('2026-10-06T09:00:00Z'), eventId: event.id },
})
const cascaded = await prisma.actionItem.create({
  data: { title: 'Angebot schicken', meetingId: meeting.id },
})
const cleared = await prisma.note.create({
  data: { title: 'Protokoll', meetingId: meeting.id },
})

await prisma.meeting.delete({ where: { id: meeting.id } })

check(
  'eine Cascade-Loeschung steht im Log',
  (await opsFor('ActionItem', cascaded.id)).at(-1)?.op,
  'delete',
)

check(
  'ein auf null gesetzter Verweis steht als schmaler Patch im Log',
  (await opsFor('Note', cleared.id)).at(-1),
  {
    deviceId: HOST,
    op: 'upsert',
    fields: ['meetingId'],
    patch: { meetingId: null },
    hlc: (await opsFor('Note', cleared.id)).at(-1)?.hlc,
  },
)

check(
  'die Notiz selbst lebt noch',
  (await dbRaw.note.findUnique({ where: { id: cleared.id } }))?.meetingId,
  null,
)

check(
  'auch das Meeting selbst steht als Loeschung im Log',
  (await opsFor('Meeting', meeting.id)).at(-1)?.op,
  'delete',
)

// ---------------------------------------------------------------------------
// Bulk writes
// ---------------------------------------------------------------------------

const leadA = await prisma.lead.create({ data: { title: 'Lead A', stage: 'NEW' } })
const leadB = await prisma.lead.create({ data: { title: 'Lead B', stage: 'NEW' } })

await prisma.lead.updateMany({ where: { stage: 'NEW' }, data: { probability: 25 } })

check(
  'updateMany protokolliert jede getroffene Zeile',
  [(await opsFor('Lead', leadA.id)).at(-1)?.patch, (await opsFor('Lead', leadB.id)).at(-1)?.patch],
  [{ probability: 25 }, { probability: 25 }],
)

await prisma.lead.deleteMany({ where: { stage: 'NEW' } })

check(
  'deleteMany protokolliert jede getroffene Zeile',
  [(await opsFor('Lead', leadA.id)).at(-1)?.op, (await opsFor('Lead', leadB.id)).at(-1)?.op],
  ['delete', 'delete'],
)

// ---------------------------------------------------------------------------
// A reference this machine does not have
// ---------------------------------------------------------------------------

check(
  'ein Verweis ins Leere wird gemeldet, nicht verschluckt',
  (
    await applyOps([
      phoneOp({
        millis: NOW - 50_000,
        entity: 'TimeEntry',
        entityId: 'te-orphan',
        patch: {
          projectId: 'gibt-es-nicht',
          startedAt: '2026-10-03T08:00:00.000Z',
          description: 'Anfahrt',
        },
      }),
    ])
  ).map((r) => `${r.status}: ${r.reason ?? ''}`),
  ['failed: Verweis zeigt auf eine Zeile, die hier nicht existiert'],
)

// Parent and child in one batch, child first. The second pass has to catch it.
check(
  'Elternzeile und Kind in einem Schwung, in der falschen Reihenfolge',
  (
    await applyOps([
      phoneOp({
        millis: NOW - 40_000,
        entity: 'TimeEntry',
        entityId: 'te-child',
        patch: {
          projectId: 'pr-parent',
          startedAt: '2026-10-03T08:00:00.000Z',
          description: 'Anfahrt Kunde',
        },
      }),
      phoneOp({
        millis: NOW - 39_000,
        entity: 'Project',
        entityId: 'pr-parent',
        patch: { key: 'NEU-VOM-TELEFON', name: 'Neu vom Telefon' },
      }),
    ])
  ).map((r) => r.status),
  ['applied', 'applied'],
)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
await dbRaw.$disconnect()
if (fail > 0) process.exit(1)
