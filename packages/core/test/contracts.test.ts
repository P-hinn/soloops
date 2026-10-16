import {
  buildContractRows,
  contractNoteTitle,
  foldContractNotes,
  parseContractNote,
  resolveSignedPath,
  SIGNED_ROOT,
} from '../src/services/contracts.js'

/**
 * The note convention.
 *
 * It is the only record a contract leaves, so reading it back has to survive
 * what a workflow writes *and* what a person types into the same note three
 * months later.
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

// ---------------------------------------------------------------------------
// Schreiben und wieder lesen
// ---------------------------------------------------------------------------

const sent = contractNoteTitle({
  title: 'Geheimhaltungsvereinbarung (NDA)',
  status: 'versendet',
  on: new Date('2026-10-12T09:00:00Z'),
  zohoRequestId: 'abc123',
})

check(
  'so schreibt der Workflow die Notiz',
  sent,
  '[VERTRAG] Geheimhaltungsvereinbarung (NDA) – versendet 12.10.2026 – Zoho-ID: abc123',
)

check('und so liest sie sich zurück', parseContractNote(sent), {
  title: 'Geheimhaltungsvereinbarung (NDA)',
  status: 'versendet',
  on: '2026-10-12',
  zohoRequestId: 'abc123',
  file: null,
})

const signed = contractNoteTitle({
  title: 'Werkvertrag',
  status: 'signiert',
  on: new Date('2026-10-20T09:00:00Z'),
  zohoRequestId: 'abc123',
  file: 'cl1/2026-10-20-werkvertrag-abc123.pdf',
})

check('die signierte Notiz trägt die Datei', parseContractNote(signed), {
  title: 'Werkvertrag',
  status: 'signiert',
  on: '2026-10-20',
  zohoRequestId: 'abc123',
  file: 'cl1/2026-10-20-werkvertrag-abc123.pdf',
})

// ---------------------------------------------------------------------------
// Was nicht dazugehört
// ---------------------------------------------------------------------------

check('eine normale Notiz ist kein Vertrag', parseContractNote('Telefonat mit Müller'), null)
check('der Prefix allein ist keiner', parseContractNote('[VERTRAG]'), null)
check('und auch nicht mit Leerzeichen', parseContractNote('[VERTRAG]    '), null)

check(
  'ohne Zusätze bleibt es ein versendeter Vertrag',
  parseContractNote('[VERTRAG] Dienstvertrag'),
  { title: 'Dienstvertrag', status: 'versendet', on: null, zohoRequestId: null, file: null },
)

check(
  'ein Bindestrich statt Gedankenstrich tut es auch',
  parseContractNote('[VERTRAG] NDA - signiert 01.02.2026')?.status,
  'signiert',
)

check(
  'ein unlesbares Datum macht die Zeile nicht kaputt',
  parseContractNote('[VERTRAG] NDA – versendet irgendwann'),
  { title: 'NDA', status: 'versendet', on: null, zohoRequestId: null, file: null },
)

check(
  'ein ISO-Datum wird auch genommen',
  parseContractNote('[VERTRAG] NDA – signiert 2026-03-04')?.on,
  '2026-03-04',
)

// ---------------------------------------------------------------------------
// Zwei Notizen, eine Zeile
//
// Verschickt und signiert gehören zum selben Vertrag; die Übersicht zeigt
// eine Zeile mit dem neuesten Stand und dem Versanddatum von vorher.
// ---------------------------------------------------------------------------

const note = (id: string, title: string, createdAt: string) => ({
  id,
  createdAt: new Date(createdAt),
  parsed: parseContractNote(title)!,
})

const folded = foldContractNotes([
  note('n1', sent, '2026-10-12T09:00:00Z'),
  note(
    'n2',
    signed.replace('Werkvertrag', 'Geheimhaltungsvereinbarung (NDA)'),
    '2026-10-20T09:00:00Z',
  ),
])

check('aus zwei Notizen wird eine Zeile', folded.length, 1)
check('mit dem neuesten Stand', folded[0]?.status, 'signiert')
check('und dem Versanddatum von vorher', folded[0]?.sentOn, '2026-10-12')
check(
  'die Datei kommt von der signierten',
  folded[0]?.file,
  'cl1/2026-10-20-werkvertrag-abc123.pdf',
)

const zwei = foldContractNotes([
  note('n1', '[VERTRAG] NDA – versendet 01.10.2026 – Zoho-ID: a1', '2026-10-01T09:00:00Z'),
  note('n2', '[VERTRAG] NDA – versendet 05.10.2026 – Zoho-ID: b2', '2026-10-05T09:00:00Z'),
])

check(
  'zwei Verträge gleichen Namens bleiben zwei Zeilen, solange die Zoho-ID sie trennt',
  zwei.length,
  2,
)

check('die neueste steht oben', zwei[0]?.zohoRequestId, 'b2')

const handschriftlich = foldContractNotes([
  note('n1', '[VERTRAG] Rahmenvertrag – versendet 01.09.2026', '2026-09-01T09:00:00Z'),
  note('n2', '[VERTRAG] Rahmenvertrag – signiert 10.09.2026', '2026-09-10T09:00:00Z'),
])

check(
  'ohne Zoho-ID hält der Titel die beiden zusammen',
  [handschriftlich.length, handschriftlich[0]?.status, handschriftlich[0]?.sentOn],
  [1, 'signiert', '2026-09-01'],
)

// ---------------------------------------------------------------------------
// Der Pfad zur signierten Datei
//
// Er kommt aus dem Titel einer Notiz, und Notizen sind von Hand editierbar —
// das hier ist die Grenze, hinter der eine Datei geöffnet wird.
// ---------------------------------------------------------------------------

check(
  'der normale Fall',
  resolveSignedPath('cl1-2026-10-20-nda-abc.pdf'),
  `${SIGNED_ROOT}/cl1-2026-10-20-nda-abc.pdf`,
)

check('Leerzeichen drumherum stören nicht', resolveSignedPath('  x.pdf  '), `${SIGNED_ROOT}/x.pdf`)

check(
  'ein absoluter Pfad in die Ablage ist erlaubt',
  resolveSignedPath(`${SIGNED_ROOT}/x.pdf`),
  `${SIGNED_ROOT}/x.pdf`,
)

check('Grossschreibung bei der Endung', resolveSignedPath('x.PDF'), `${SIGNED_ROOT}/x.PDF`)

// Was draussen bleiben muss
check('Verzeichniswechsel nach oben', resolveSignedPath('../../etc/passwd.pdf'), null)
check('tiefer verschachtelt', resolveSignedPath('a/../../../etc/shadow.pdf'), null)
check('ein absoluter Pfad woanders hin', resolveSignedPath('/etc/passwd.pdf'), null)
check(
  'ein Nachbarverzeichnis mit gleichem Anfang',
  resolveSignedPath('../signiert-fremd/x.pdf'),
  null,
)
check('die Ablage selbst', resolveSignedPath(SIGNED_ROOT), null)
check('ein Unterordner', resolveSignedPath('kunde/x.pdf'), null)
check('keine PDF', resolveSignedPath('x.txt'), null)
check('nur so getan als waere es eine', resolveSignedPath('x.pdf.sh'), null)
check('leer', resolveSignedPath('   '), null)
check('ein Nullbyte', resolveSignedPath('x.pdf\u0000.sh'), null)

// ---------------------------------------------------------------------------
// Die Übersicht
//
// Notizen und offene Aufgaben zu je einer Zeile. Interessant ist, was pro
// Kunde getrennt bleiben muss und welche Aufgabe an welcher Zeile hängt.
// ---------------------------------------------------------------------------

const client = (id: string) => ({ id, name: `Kunde ${id}`, company: null })

const noteOf = (id: string, title: string, createdAt: string, clientId: string | null) => ({
  id,
  title,
  createdAt: new Date(createdAt),
  clientId,
  client: clientId ? client(clientId) : null,
})

const taskOf = (id: string, title: string, clientId: string | null) => ({
  id,
  title,
  dueOn: null,
  clientId,
})

const rows = buildContractRows(
  [
    noteOf(
      'n1',
      '[VERTRAG] NDA – versendet 01.10.2026 – Zoho-ID: a1',
      '2026-10-01T09:00:00Z',
      'c1',
    ),
    noteOf('n2', '[VERTRAG] NDA – signiert 05.10.2026 – Zoho-ID: a1', '2026-10-05T09:00:00Z', 'c1'),
    noteOf(
      'n3',
      '[VERTRAG] Werkvertrag – versendet 08.10.2026 – Zoho-ID: b2',
      '2026-10-08T09:00:00Z',
      'c1',
    ),
    noteOf(
      'n4',
      '[VERTRAG] NDA – versendet 02.10.2026 – Zoho-ID: c3',
      '2026-10-02T09:00:00Z',
      'c2',
    ),
    noteOf('n5', 'Ganz normale Notiz', '2026-10-09T09:00:00Z', 'c1'),
  ],
  [taskOf('t1', 'Signatur ausstehend: Werkvertrag', 'c1')],
)

check('nur Vertragsnotizen werden zu Zeilen', rows.length, 3)
check(
  'neueste zuerst',
  rows.map((r) => r.title),
  ['Werkvertrag', 'NDA', 'NDA'],
)
// Eine gefaltete Zeile behält das Datum der ersten Notiz — sie ist so alt wie
// der Versand, nicht wie die Unterschrift.
check(
  'sortiert nach Vertragsbeginn, neueste zuerst',
  rows.map((r) => `${r.title}/${r.clientId}`),
  ['Werkvertrag/c1', 'NDA/c2', 'NDA/c1'],
)
check(
  'zwei Notizen desselben Vertrags sind eine Zeile',
  rows.find((r) => r.title === 'NDA' && r.clientId === 'c1')?.status,
  'signiert',
)
check(
  'gleicher Vertragsname bei zwei Kunden bleibt getrennt',
  rows.filter((r) => r.title === 'NDA').length,
  2,
)
check('die offene Aufgabe hängt an ihrem Vertrag', rows[0]?.openTask?.id, 't1')
check('und an keinem anderen', rows.filter((r) => r.openTask).length, 1)

// Zwei gleichnamige Verträge beim selben Kunden sind über den Titel nicht zu
// unterscheiden — dann darf eine Aufgabe trotzdem nur einmal vergeben werden.
const doppelt = buildContractRows(
  [
    noteOf(
      'n1',
      '[VERTRAG] NDA – versendet 01.10.2026 – Zoho-ID: a1',
      '2026-10-01T09:00:00Z',
      'c1',
    ),
    noteOf(
      'n2',
      '[VERTRAG] NDA – versendet 03.10.2026 – Zoho-ID: a2',
      '2026-10-03T09:00:00Z',
      'c1',
    ),
  ],
  [taskOf('t1', 'Signatur ausstehend: NDA', 'c1')],
)

check(
  'eine Aufgabe wird nur einmal vergeben',
  doppelt.map((r) => r.openTask?.id ?? null),
  [null, 't1'],
)

const fremd = buildContractRows(
  [noteOf('n1', '[VERTRAG] NDA – versendet 01.10.2026', '2026-10-01T09:00:00Z', 'c1')],
  [taskOf('t1', 'Signatur ausstehend: NDA', 'c2')],
)
check('eine Aufgabe eines anderen Kunden zählt nicht', fremd[0]?.openTask, null)

const ohneKunde = buildContractRows(
  [noteOf('n1', '[VERTRAG] NDA – versendet 01.10.2026', '2026-10-01T09:00:00Z', null)],
  [taskOf('t1', 'Signatur ausstehend: NDA', null)],
)
check('eine Notiz ohne Kunden findet ihre Aufgabe ohne Kunden', ohneKunde[0]?.openTask?.id, 't1')
check('und meldet keinen Kunden', ohneKunde[0]?.clientId, null)

check('nichts rein, nichts raus', buildContractRows([], []), [])

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
