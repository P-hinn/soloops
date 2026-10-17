import {
  draftOf,
  emptyDraft,
  projectPayload,
  statusLabel,
  statusTone,
  type ProjectFields,
} from '../src/lib/projects.js'

/**
 * Das Projektformular hin und zurück.
 *
 * Plain tsx wie die anderen Frontend-Tests, kein Runner: zu prüfen ist nur
 * die Umrechnung zwischen Formular und API — Tag gegen Zeitpunkt, Euro gegen
 * Cent, Leerstring gegen null.
 *
 * Das geleerte Datum ist der Grund für diese Datei: `''` muss als `null`
 * rausgehen, nicht als `undefined`. Ein PATCH ohne das Feld behält den alten
 * Wert — im Formular liest sich das als "die Deadline, die ich gelöscht habe,
 * ist noch da".
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

const PROJECT: ProjectFields = {
  key: 'ACME-DWH',
  name: 'Data Warehouse',
  status: 'PAUSED',
  color: '#5c76ff',
  description: 'Zwei Quellen, ein Modell.',
  clientId: 'c1',
  hourlyRateCents: 9500,
  budgetCents: 1_200_000,
  startsOn: '2026-01-05T00:00:00.000Z',
  dueOn: '2026-03-31T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

check('Status wird übersetzt', statusLabel('ACTIVE'), 'aktiv')
check('unbekannter Status bleibt stehen', statusLabel('WEIRD'), 'WEIRD')
check('Archiviertes bekommt keine Farbe', statusTone('ARCHIVED'), '')
check('Pausiertes warnt', statusTone('PAUSED'), 'badge-warn')

// ---------------------------------------------------------------------------
// Projekt ins Formular
// ---------------------------------------------------------------------------

const draft = draftOf(PROJECT)
check('Datum kommt als Tag an', [draft.startsOn, draft.dueOn], ['2026-01-05', '2026-03-31'])
check('Cent kommen als Euro an', [draft.hourlyRate, draft.budget], ['95.00', '12000.00'])
check('Kunde kommt aus clientId', draft.clientId, 'c1')
check(
  'Kunde kommt notfalls aus der Relation',
  draftOf({ ...PROJECT, clientId: null, client: { id: 'c2' } }).clientId,
  'c2',
)
check(
  'leere Felder werden Leerstrings',
  (({ startsOn, dueOn, hourlyRate, budget, description }) => [
    startsOn,
    dueOn,
    hourlyRate,
    budget,
    description,
  ])(
    draftOf({
      ...PROJECT,
      description: null,
      hourlyRateCents: null,
      budgetCents: null,
      startsOn: null,
      dueOn: null,
    }),
  ),
  ['', '', '', '', ''],
)
check('kein Budget ist nicht 0 €', draftOf({ ...PROJECT, budgetCents: 0 }).budget, '0.00')

// ---------------------------------------------------------------------------
// Formular zur API
// ---------------------------------------------------------------------------

check('hin und zurück ändert nichts', projectPayload(draft), {
  key: 'ACME-DWH',
  name: 'Data Warehouse',
  clientId: 'c1',
  status: 'PAUSED',
  color: '#5c76ff',
  description: 'Zwei Quellen, ein Modell.',
  startsOn: '2026-01-05T00:00:00.000Z',
  dueOn: '2026-03-31T00:00:00.000Z',
  hourlyRateCents: 9500,
  budgetCents: 1_200_000,
})

const cleared = projectPayload({ ...draft, dueOn: '', budget: '', description: '  ' })
check(
  'geleertes Feld geht als null raus, nicht als undefined',
  [cleared.dueOn, cleared.budgetCents, cleared.description],
  [null, null, null],
)
check(
  'das Kürzel wird großgeschrieben und getrimmt',
  projectPayload({ ...emptyDraft(), key: ' acme-dwh ', name: ' Relaunch ' }),
  {
    key: 'ACME-DWH',
    name: 'Relaunch',
    clientId: null,
    status: 'ACTIVE',
    color: '#6366f1',
    description: null,
    startsOn: null,
    dueOn: null,
    hourlyRateCents: null,
    budgetCents: null,
  },
)
check(
  'Komma zählt als Dezimaltrenner',
  projectPayload({ ...draft, hourlyRate: '95,50' }).hourlyRateCents,
  9550,
)
check(
  'Bruchteile von Cent werden gerundet',
  projectPayload({ ...draft, hourlyRate: '95.555' }).hourlyRateCents,
  9556,
)
check(
  'Buchstaben im Betrag sind kein Betrag, nicht NaN',
  projectPayload({ ...draft, budget: 'viel' }).budgetCents,
  null,
)
check('intern heißt kein Kunde', projectPayload({ ...draft, clientId: '' }).clientId, null)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
