import { format, observe, parse, tick, type HlcState } from '../src/services/hlc.js'
import { decodeField, decodePatch, encodeChanged, encodeRow } from '../src/services/syncCodec.js'
import { decide, groupKnownOps, type IncomingOp, type KnownOp } from '../src/services/syncMerge.js'
import { DELETE_SIDE_EFFECTS, SYNC_ENTITY_NAMES, specOf } from '../src/services/syncEntities.js'

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
// The clock
// ---------------------------------------------------------------------------

const PHONE = 'phone'
const MAC = 'mac'

/** A stamp at a given millisecond and counter, for the device named. */
const stamp = (millis: number, counter: number, device: string) =>
  format({ millis, counter }, device)

check('ein Stempel laesst sich wieder auseinandernehmen', parse(stamp(1759497600000, 7, PHONE)), {
  millis: 1759497600000,
  counter: 7,
  deviceId: PHONE,
})

check('Unsinn ist kein Stempel', parse('irgendwas'), null)
check('ein leerer Cursor ist kein Stempel', parse(''), null)

// Sorting as text has to sort as time — everything downstream relies on it.
check('spaetere Millisekunde sortiert spaeter', stamp(2, 0, PHONE) > stamp(1, 99999, PHONE), true)
check(
  'gleiche Millisekunde, hoeherer Zaehler sortiert spaeter',
  stamp(1, 2, PHONE) > stamp(1, 1, PHONE),
  true,
)
check('zwei Geraete erzeugen nie denselben Stempel', stamp(1, 1, PHONE) === stamp(1, 1, MAC), false)

check('die Uhr laeuft mit der Wanduhr', tick({ millis: 10, counter: 5 }, 20), {
  millis: 20,
  counter: 0,
})

check('stillstehende Wanduhr: der Zaehler laeuft weiter', tick({ millis: 20, counter: 0 }, 20), {
  millis: 20,
  counter: 1,
})

// This is the case the whole clock exists for. A Mac waking from sleep can
// report a time behind the phone's; a plain `updatedAt` would drop the newer
// edit here.
check(
  'rueckwaerts laufende Wanduhr schiebt den Stempel nicht zurueck',
  tick({ millis: 1000, counter: 0 }, 900),
  { millis: 1000, counter: 1 },
)

check(
  'ein fremder Stempel zieht die eigene Uhr hinter sich',
  observe({ millis: 100, counter: 0 }, stamp(5000, 3, PHONE), 100),
  { millis: 5000, counter: 4 },
)

check(
  'nach dem Beobachten ist der eigene naechste Stempel spaeter',
  (() => {
    const remote = stamp(5000, 3, PHONE)
    const pulled: HlcState = observe({ millis: 100, counter: 0 }, remote, 100)
    return format(pulled, MAC) > remote
  })(),
  true,
)

check(
  'eine gesunde Wanduhr vor beiden setzt den Zaehler zurueck',
  observe({ millis: 100, counter: 9 }, stamp(200, 4, PHONE), 300),
  { millis: 300, counter: 0 },
)

// ---------------------------------------------------------------------------
// The codec
// ---------------------------------------------------------------------------

check('ein ISO-String wird ein Datum', decodeField('date', '2026-10-03T08:00:00.000Z'), {
  ok: true,
  value: new Date('2026-10-03T08:00:00.000Z'),
})

check('ein kaputtes Datum wird gemeldet, nicht geraten', decodeField('date', 'morgen'), {
  ok: false,
  reason: 'ungültiges Datum',
})

check('null ist ein Wert, kein fehlender Wert', decodeField('date', null), {
  ok: true,
  value: null,
})

check('eine Zahl mit Komma ist keine Ganzzahl', decodeField('int', 1.5), {
  ok: false,
  reason: 'Ganzzahl erwartet',
})

check('"true" ist kein Boolean', decodeField('bool', 'true'), {
  ok: false,
  reason: 'Boolean erwartet',
})

check(
  'unbekannte Felder werden verworfen, nicht abgelehnt',
  decodePatch('ActionItem', { title: 'X', erfundenesFeld: 1 }),
  { ok: true, patch: { title: 'X' }, unknownFields: ['erfundenesFeld'] },
)

check(
  'ein kaputtes Feld laesst den ganzen Patch scheitern',
  decodePatch('ActionItem', { title: 'X', dueOn: 'irgendwann' }),
  { ok: false, reason: 'dueOn: ungültiges Datum' },
)

check(
  'host-lokale Spalten gehen nicht mit auf Reisen',
  decodePatch('Lead', { title: 'X', followUpNotifiedAt: '2026-10-03T00:00:00.000Z' }),
  { ok: true, patch: { title: 'X' }, unknownFields: ['followUpNotifiedAt'] },
)

check(
  'eine Zeile wird zu JSON, Daten als ISO',
  encodeRow('ActionItem', {
    id: 'a1',
    title: 'Rueckruf',
    done: false,
    dueOn: new Date('2026-10-04T10:00:00.000Z'),
    assignee: null,
    source: 'MANUAL',
    meetingId: null,
    projectId: null,
    createdAt: new Date(),
  }),
  {
    title: 'Rueckruf',
    done: false,
    dueOn: '2026-10-04T10:00:00.000Z',
    assignee: null,
    source: 'MANUAL',
    meetingId: null,
    projectId: null,
  },
)

check(
  'ein schmaler Patch traegt nur das Angefasste',
  encodeChanged('ActionItem', { id: 'a1', title: 'Rueckruf', done: true }, ['done']),
  { done: true },
)

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

const op = (over: Partial<IncomingOp> = {}): IncomingOp => ({
  deviceId: PHONE,
  seq: 1,
  hlc: stamp(1000, 0, PHONE),
  entity: 'ActionItem',
  entityId: 'a1',
  op: 'upsert',
  patch: { title: 'Rueckruf' },
  ...over,
})

const known = (hlc: string, kind: 'upsert' | 'delete', fields: string[]): KnownOp => ({
  hlc,
  op: kind,
  fields,
})

check(
  'eine neue Zeile wird angelegt',
  decide({
    incoming: op({ patch: { title: 'Rueckruf', done: false } }),
    known: [],
    exists: false,
  }),
  { kind: 'create', patch: { title: 'Rueckruf', done: false } },
)

check(
  'ohne Pflichtfeld wird nicht angelegt',
  decide({ incoming: op({ patch: { done: true } }), known: [], exists: false }),
  { kind: 'skip', reason: 'Pflichtfelder fehlen: title' },
)

check(
  'eine bestehende Zeile wird geaendert',
  decide({ incoming: op({ patch: { done: true } }), known: [], exists: true }),
  { kind: 'update', patch: { done: true } },
)

// The case the per-field rule exists for: the Mac wrote the title at 2000,
// the phone ticked `done` at 1000. Row-level LWW would discard the tick.
check(
  'zwei Geraete, zwei Felder, beide Aenderungen bleiben',
  decide({
    incoming: op({ hlc: stamp(1000, 0, PHONE), patch: { done: true } }),
    known: [known(stamp(2000, 0, MAC), 'upsert', ['title'])],
    exists: true,
  }),
  { kind: 'update', patch: { done: true } },
)

check(
  'dasselbe Feld, lokal neuer: der aeltere Schreiber verliert',
  decide({
    incoming: op({ hlc: stamp(1000, 0, PHONE), patch: { done: true } }),
    known: [known(stamp(2000, 0, MAC), 'upsert', ['done'])],
    exists: true,
  }),
  { kind: 'skip', reason: 'jedes Feld lokal neuer' },
)

check(
  'dasselbe Feld, lokal aelter: der neuere Schreiber gewinnt',
  decide({
    incoming: op({ hlc: stamp(3000, 0, PHONE), patch: { done: true } }),
    known: [known(stamp(2000, 0, MAC), 'upsert', ['done'])],
    exists: true,
  }),
  { kind: 'update', patch: { done: true } },
)

check(
  'aus einem gemischten Patch bleibt das Frische uebrig',
  decide({
    incoming: op({
      hlc: stamp(1000, 0, PHONE),
      patch: { title: 'Neu', done: true, assignee: 'Philipp' },
    }),
    known: [known(stamp(2000, 0, MAC), 'upsert', ['title'])],
    exists: true,
  }),
  { kind: 'update', patch: { done: true, assignee: 'Philipp' } },
)

check(
  'ein Op gegen sich selbst gehalten blockiert sich nicht',
  decide({
    incoming: op({ hlc: stamp(1000, 0, PHONE), patch: { done: true } }),
    known: [known(stamp(1000, 0, PHONE), 'upsert', ['done'])],
    exists: true,
  }),
  { kind: 'update', patch: { done: true } },
)

check(
  'ein Loeschen wird ausgefuehrt',
  decide({ incoming: op({ op: 'delete', patch: null }), known: [], exists: true }),
  { kind: 'delete' },
)

check(
  'ein Loeschen auf eine schon fehlende Zeile ist still',
  decide({ incoming: op({ op: 'delete', patch: null }), known: [], exists: false }),
  { kind: 'skip', reason: 'bereits geloescht' },
)

// Stated choice, not a side effect of the algorithm: an edit made after the
// delete keeps the row, because the edit is work and the delete is not.
check(
  'eine Aenderung nach dem Loeschen haelt die Zeile am Leben',
  decide({
    incoming: op({ op: 'delete', patch: null, hlc: stamp(1000, 0, PHONE) }),
    known: [known(stamp(2000, 0, MAC), 'upsert', ['title'])],
    exists: true,
  }),
  { kind: 'skip', reason: 'nach dem Loeschen wurde die Zeile geaendert' },
)

check(
  'eine Aenderung vor einem spaeteren Loeschen wird nicht mehr angewandt',
  decide({
    incoming: op({ hlc: stamp(1000, 0, PHONE), patch: { done: true } }),
    known: [known(stamp(2000, 0, MAC), 'delete', [])],
    exists: false,
  }),
  { kind: 'skip', reason: 'Zeile wurde danach geloescht' },
)

check(
  'eine unbekannte Entitaet wird gemeldet, nicht angewandt',
  decide({ incoming: op({ entity: 'Invoice' }), known: [], exists: false }),
  { kind: 'skip', reason: 'unbekannte Entitaet Invoice' },
)

check(
  'ein Patch nur aus unbekannten Feldern aendert nichts',
  decide({
    incoming: op({ patch: { erfundenesFeld: 1 } }),
    known: [],
    exists: true,
  }),
  { kind: 'skip', reason: 'jedes Feld lokal neuer' },
)

check(
  'Ops werden nach Zeile gruppiert',
  [
    ...groupKnownOps([
      { entity: 'ActionItem', entityId: 'a1', hlc: 'h1', op: 'upsert', fields: ['done'] },
      { entity: 'ActionItem', entityId: 'a2', hlc: 'h2', op: 'delete', fields: [] },
      { entity: 'ActionItem', entityId: 'a1', hlc: 'h3', op: 'upsert', fields: ['title'] },
    ]).entries(),
  ].map(([key, ops]) => [key, ops.length]),
  [
    ['ActionItem a1', 2],
    ['ActionItem a2', 1],
  ],
)

// ---------------------------------------------------------------------------
// The registry
//
// These two are the ones that rot. A relation added in schema.prisma without
// a line in DELETE_SIDE_EFFECTS is a hole the sync never reports.
// ---------------------------------------------------------------------------

check(
  'jede synchronisierte Entitaet hat einen Eintrag in der Cascade-Tabelle',
  SYNC_ENTITY_NAMES.filter((name) => DELETE_SIDE_EFFECTS[name] === undefined),
  [],
)

check(
  'jede Cascade zeigt auf ein Feld, das es auf der Zielentitaet gibt',
  SYNC_ENTITY_NAMES.flatMap((name) =>
    DELETE_SIDE_EFFECTS[name]
      .filter((effect) => !(effect.fk in specOf(effect.entity).fields))
      .map((effect) => `${name} -> ${effect.entity}.${effect.fk}`),
  ),
  [],
)

check(
  'Fremdschluessel zeigen immer auf einen niedrigeren Rang',
  SYNC_ENTITY_NAMES.flatMap((name) =>
    DELETE_SIDE_EFFECTS[name]
      .filter((effect) => specOf(effect.entity).rank <= specOf(name).rank && effect.entity !== name)
      .map((effect) => `${name}(${specOf(name).rank}) -> ${effect.entity}`),
  ),
  [],
)

check(
  'jedes Pflichtfeld ist auch ein synchronisiertes Feld',
  SYNC_ENTITY_NAMES.flatMap((name) =>
    specOf(name)
      .required.filter((field) => !(field in specOf(name).fields))
      .map((field) => `${name}.${field}`),
  ),
  [],
)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
