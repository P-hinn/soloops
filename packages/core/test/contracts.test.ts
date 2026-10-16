import {
  contractDaysLeft,
  contractState,
  EXPIRY_WARNING_DAYS,
  type ContractState,
} from '@soloops/shared'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isPdf,
  removeContractFile,
  resolveSignedPath,
  signedFileName,
  SIGNED_ROOT,
  storeContractFile,
} from '../src/services/contracts.js'

/**
 * Was an einem Vertrag ohne Datenbank entschieden wird.
 *
 * Zwei Dinge: der Dateiname, den Upload und Signatur-Workflow erzeugen — er
 * muss flach bleiben und darf zwei Verträge nicht übereinanderlegen — und der
 * Pfad, hinter dem eine Datei geöffnet wird. Letzteres ist eine
 * Sicherheitsgrenze, keine Bequemlichkeit.
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
// Der Dateiname
// ---------------------------------------------------------------------------

const on = new Date('2026-10-16T14:30:00Z')

check(
  'Kunde, Datum, Titel, eindeutiger Teil',
  signedFileName({ clientId: 'cl1', title: 'NDA', unique: 'req7', on }),
  'cl1-2026-10-16-nda-req7.pdf',
)

check(
  'Umlaute werden umgeschrieben, nicht weggeworfen',
  signedFileName({ clientId: 'cl1', title: 'Werkvertrag Küche & Bäder', unique: 'x', on }),
  'cl1-2026-10-16-werkvertrag-kueche-baeder-x.pdf',
)

check(
  'ein Titel aus Sonderzeichen bleibt ein Name',
  signedFileName({ clientId: 'cl1', title: '«»/-', unique: 'x', on }),
  'cl1-2026-10-16-vertrag-x.pdf',
)

check(
  'der Dateiname enthält kein Verzeichnis',
  signedFileName({ clientId: 'cl1', title: '../../etc/passwd', unique: 'x', on }).includes('/'),
  false,
)

check(
  'und ist auch nach einem sehr langen Titel noch zu öffnen',
  resolveSignedPath(
    signedFileName({ clientId: 'cl1', title: 'Dienstvertrag '.repeat(40), unique: 'x', on }),
  ) !== null,
  true,
)

check(
  'zwei Verträge gleichen Namens überschreiben sich nicht',
  signedFileName({ clientId: 'cl1', title: 'NDA', unique: 'a', on }) ===
    signedFileName({ clientId: 'cl1', title: 'NDA', unique: 'b', on }),
  false,
)

// ---------------------------------------------------------------------------
// Der Pfad zur Datei
//
// Der Name steht in der Datenbank, geschrieben von einem Upload und von einem
// n8n-Workflow — das hier ist die Grenze, hinter der eine Datei geöffnet wird.
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
check('ein Nullbyte', resolveSignedPath(`x.pdf${String.fromCharCode(0)}.sh`), null)

// ---------------------------------------------------------------------------
// Laufzeit und Zustand
//
// Ein abgelaufener Vertrag wird nirgends geschrieben — es gibt keinen Job,
// der nachts durch die Tabelle läuft. Also wird er beim Lesen abgeleitet, und
// zwar in API und Oberfläche aus derselben Funktion.
// ---------------------------------------------------------------------------

// Mittags, nicht um 23 Uhr: verglichen wird im lokalen Kalender (TZ), und
// 23:00 UTC ist in Berlin schon der nächste Tag — ein Testdatum, das die
// Grenze selbst verschiebt, prüft nicht die Funktion, sondern die Zeitzone.
const heute = new Date('2026-10-16T12:00:00Z')

check('ohne Enddatum keine Restlaufzeit', contractDaysLeft(null, heute), null)
check('heute endet heute', contractDaysLeft(new Date('2026-10-16T00:00:00Z'), heute), 0)
check('morgen ist ein Tag', contractDaysLeft('2026-10-17T00:00:00Z', heute), 1)
check('gestern ist minus eins', contractDaysLeft('2026-10-15T12:00:00Z', heute), -1)
check('ein unlesbares Datum ist keins', contractDaysLeft('übermorgen', heute), null)

const state = (status: string, endsOn: string | null): ContractState =>
  contractState({ status, endsOn }, heute)

check('ein Entwurf ist ein Entwurf', state('entwurf', null), 'entwurf')
check('versendet bleibt versendet', state('versendet', null), 'versendet')
check('abgelehnt bleibt abgelehnt', state('abgelehnt', null), 'abgelehnt')
check('von Hand beendet bleibt beendet', state('beendet', '2027-01-01T00:00:00Z'), 'beendet')
check('ein Status, den es nicht gibt, ist ein Entwurf', state('irgendwas', null), 'entwurf')

check('unterschrieben und ohne Ende läuft', state('signiert', null), 'laeuft')
check('unterschrieben und noch lange läuft', state('signiert', '2027-10-16T00:00:00Z'), 'laeuft')
check(
  'kurz vor dem Ende will er Aufmerksamkeit',
  state('signiert', '2026-11-10T00:00:00Z'),
  'laeuft-ab',
)
check(
  'die Warnschwelle selbst zählt noch dazu',
  contractState(
    { status: 'signiert', endsOn: new Date(heute.getTime() + EXPIRY_WARNING_DAYS * 86_400_000) },
    heute,
  ),
  'laeuft-ab',
)
check('danach ist er abgelaufen', state('signiert', '2026-10-15T00:00:00Z'), 'abgelaufen')
check('am letzten Tag noch nicht', state('signiert', '2026-10-16T00:00:00Z'), 'laeuft-ab')

// ---------------------------------------------------------------------------
// Die Ablage selbst
//
// Gegen ein Wegwerf-Verzeichnis statt gegen /data: Schreiben und Löschen sind
// die beiden Stellen, an denen die Pfadprüfung halten muss, und sie gehören
// deshalb in den Service und nicht in eine Route, die sich nur mit einem
// HTTP-Server testen ließe.
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'soloops-vertraege-'))
const pdf = Buffer.from('%PDF-1.4\nirgendwas\n')

check('ein PDF erkennt man am Anfang', isPdf(pdf), true)
check('eine Textdatei nicht', isPdf(Buffer.from('Sehr geehrte Damen und Herren')), false)
check('und ein leerer Puffer auch nicht', isPdf(Buffer.alloc(0)), false)

const erste = await storeContractFile('cl1-2026-10-16-nda-a.pdf', pdf, root)
check('der Name kommt zurück, wie er reinging', erste, 'cl1-2026-10-16-nda-a.pdf')
check('und die Bytes liegen unverändert da', await readFile(join(root, erste)), pdf)

await storeContractFile('cl1-2026-10-16-nda-b.pdf', pdf, root)
check('zwei Verträge, zwei Dateien', (await readdir(root)).length, 2)

check('ersetzen überschreibt an Ort und Stelle', await storeContractFile(erste, pdf, root), erste)
check('ohne eine dritte Datei zu hinterlassen', (await readdir(root)).length, 2)

check('entfernen entfernt', await removeContractFile(erste, root), true)
check(
  'und meldet beim zweiten Mal, dass nichts mehr da war',
  await removeContractFile(erste, root),
  false,
)
check('nichts zu entfernen ist kein Fehler', await removeContractFile(null, root), false)
check('übrig bleibt der andere Vertrag', await readdir(root), ['cl1-2026-10-16-nda-b.pdf'])

// Die Grenze gilt auch hier, nicht nur beim Lesen.
let refused = false
try {
  await storeContractFile('../entwischt.pdf', pdf, root)
} catch {
  refused = true
}
check('ein Name aus der Ablage heraus wird abgelehnt', refused, true)
check(
  'ein Löschversuch daneben fasst nichts an',
  await removeContractFile('../../etc/passwd.pdf', root),
  false,
)
check('und die Ablage ist unverändert', (await readdir(root)).length, 1)

await removeContractFile('cl1-2026-10-16-nda-b.pdf', root)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
