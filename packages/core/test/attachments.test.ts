import {
  ATTACHMENT_MAX_BYTES,
  downloadName,
  extensionOf,
  formatBytes,
  isInlineSafe,
} from '@soloops/shared'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  attachmentFileName,
  FILE_ROOT,
  removeAttachmentFile,
  resolveAttachmentPath,
  storeAttachmentFile,
} from '../src/services/attachments.js'

/**
 * Was an einer angehängten Datei ohne Datenbank entschieden wird.
 *
 * Anders als bei einem Vertrag weiß soloops nicht, was in der Datei steht —
 * sie kommt vom Kunden und kann alles sein. Entsprechend liegt der Schutz
 * woanders: der Name auf der Platte wird gebaut und nicht übernommen, der
 * Name beim Herunterladen landet in einem HTTP-Header, und was im Browser
 * direkt angezeigt werden darf, ist eine Liste erlaubter Typen statt einer
 * verbotener.
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
// Die Endung
// ---------------------------------------------------------------------------

check('die normale', extensionOf('Briefing.pdf'), '.pdf')
check('klein geschrieben', extensionOf('SCAN.PDF'), '.pdf')
check('mehrere Punkte, die letzte zählt', extensionOf('archiv.tar.gz'), '.gz')
check('ohne Endung keine', extensionOf('Makefile'), '')
check('ein Punkt am Ende ist keine', extensionOf('kaputt.'), '')
check('nichts mit Leerzeichen drin', extensionOf('x.p df'), '')
check('und nichts beliebig Langes', extensionOf('x.verylongextension'), '')

// ---------------------------------------------------------------------------
// Der Name auf der Platte
//
// Gebaut aus Kunde, Tag und der eigenen id — nie aus dem, was der Browser
// geschickt hat. Der lesbare Teil ist für den, der die Ablage im Finder
// aufmacht; die id dahinter verhindert, dass sich zwei Dateien überschreiben.
// ---------------------------------------------------------------------------

const on = new Date('2026-10-16T14:30:00Z')

check(
  'Kunde, Datum, Name, eindeutiger Teil',
  attachmentFileName({ clientId: 'cl1', name: 'Briefing.pdf', unique: 'a1', on }),
  'cl1-2026-10-16-briefing-a1.pdf',
)

check(
  'Umlaute werden umgeschrieben, nicht weggeworfen',
  attachmentFileName({ clientId: 'cl1', name: 'Küchenplan Größe 2.png', unique: 'a1', on }),
  'cl1-2026-10-16-kuechenplan-groesse-2-a1.png',
)

check(
  'ohne Endung bleibt der Name ohne',
  attachmentFileName({ clientId: 'cl1', name: 'Makefile', unique: 'a1', on }),
  'cl1-2026-10-16-makefile-a1',
)

check(
  'ein Name nur aus Sonderzeichen bleibt ein Name',
  attachmentFileName({ clientId: 'cl1', name: '«».txt', unique: 'a1', on }),
  'cl1-2026-10-16-datei-a1.txt',
)

check(
  'ein hochgeladener Pfad wird keiner',
  attachmentFileName({ clientId: 'cl1', name: '../../etc/passwd', unique: 'a1', on }).includes('/'),
  false,
)

check(
  'nach einem sehr langen Namen ist die Datei noch zu öffnen',
  resolveAttachmentPath(
    attachmentFileName({ clientId: 'cl1', name: `${'Angebot '.repeat(40)}.pdf`, unique: 'a', on }),
  ) !== null,
  true,
)

check(
  'zwei Dateien gleichen Namens überschreiben sich nicht',
  attachmentFileName({ clientId: 'cl1', name: 'Scan.pdf', unique: 'a', on }) ===
    attachmentFileName({ clientId: 'cl1', name: 'Scan.pdf', unique: 'b', on }),
  false,
)

// ---------------------------------------------------------------------------
// Der Pfad zur Datei
//
// Dieselbe Grenze wie bei den Verträgen, nur ohne Endungsprüfung: eine
// Kundendatei ist, was der Kunde geschickt hat.
// ---------------------------------------------------------------------------

check(
  'der normale Fall',
  resolveAttachmentPath('cl1-2026-10-16-briefing-a1.pdf'),
  `${FILE_ROOT}/cl1-2026-10-16-briefing-a1.pdf`,
)
check('jede Endung', resolveAttachmentPath('x.sketch'), `${FILE_ROOT}/x.sketch`)
check('auch keine', resolveAttachmentPath('x'), `${FILE_ROOT}/x`)
check(
  'Leerzeichen drumherum stören nicht',
  resolveAttachmentPath('  x.zip  '),
  `${FILE_ROOT}/x.zip`,
)
check(
  'ein absoluter Pfad in die Ablage ist erlaubt',
  resolveAttachmentPath(`${FILE_ROOT}/x.zip`),
  `${FILE_ROOT}/x.zip`,
)

// Was draussen bleiben muss
check('Verzeichniswechsel nach oben', resolveAttachmentPath('../../etc/passwd'), null)
check('tiefer verschachtelt', resolveAttachmentPath('a/../../../etc/shadow'), null)
check('ein absoluter Pfad woanders hin', resolveAttachmentPath('/etc/passwd'), null)
check('ein Nachbarverzeichnis mit gleichem Anfang', resolveAttachmentPath('../dateien-alt/x'), null)
check('die Ablage selbst', resolveAttachmentPath(FILE_ROOT), null)
check('ein Unterordner', resolveAttachmentPath('kunde/x.pdf'), null)
check('leer', resolveAttachmentPath('   '), null)
check('ein Nullbyte', resolveAttachmentPath(`x.pdf${String.fromCharCode(0)}.sh`), null)

// ---------------------------------------------------------------------------
// Der Name beim Herunterladen
//
// Er landet im Content-Disposition-Header, also darf kein Zeilenumbruch darin
// vorkommen — und er trägt den Titel aus soloops, weil "Briefing" der Grund
// ist, aus dem man eine Datei umbenennt.
// ---------------------------------------------------------------------------

check('Titel plus Endung', downloadName('Briefing', 'scan_0043.pdf'), 'Briefing.pdf')
check(
  'Leerzeichen werden zu Strichen',
  downloadName('Briefing Phase 2', 'x.pdf'),
  'Briefing-Phase-2.pdf',
)
check('Umlaute bleiben', downloadName('Müller Angebot', 'x.pdf'), 'Müller-Angebot.pdf')
check(
  'eine schon vorhandene Endung wird nicht verdoppelt',
  downloadName('Briefing.pdf', 'scan.pdf'),
  'Briefing.pdf',
)
check(
  'ohne Endung auf der Platte auch keine hier',
  downloadName('Makefile', 'Makefile'),
  'Makefile',
)
check('ein Titel aus Sonderzeichen wird ein Name', downloadName('«»', 'x.zip'), 'datei.zip')
check(
  'kein Zeilenumbruch im Header',
  downloadName(`Angebot${String.fromCharCode(13, 10)}X-Spam: ja`, 'x.pdf'),
  'Angebot-X-Spam-ja.pdf',
)
check('und kein Pfad', downloadName('../../etc/passwd', 'x.txt').includes('/'), false)

// ---------------------------------------------------------------------------
// Was der Browser direkt anzeigen darf
//
// Die Dateien kommen von derselben Herkunft wie die Oberfläche: eine
// hochgeladene HTML-Seite, die inline ausgeliefert wird, läuft mit der
// Sitzung davor.
// ---------------------------------------------------------------------------

check('ein PDF ja', isInlineSafe('application/pdf'), true)
check('ein Bild ja', isInlineSafe('image/png'), true)
check('Text mit Charset auch', isInlineSafe('text/plain; charset=utf-8'), true)
check('HTML nicht', isInlineSafe('text/html'), false)
check('ein SVG nicht', isInlineSafe('image/svg+xml'), false)
check('XML nicht', isInlineSafe('application/xml'), false)
check('und nichts Unbekanntes', isInlineSafe('application/octet-stream'), false)

// ---------------------------------------------------------------------------
// Größen, wie man sie liest
// ---------------------------------------------------------------------------

check('Bytes', formatBytes(512), '512 B')
check('Kilobytes ohne Nachkommastelle', formatBytes(867_000), '847 KB')
check('Megabytes mit einer', formatBytes(2_500_000), '2,4 MB')
check('und ab zehn ohne', formatBytes(42_000_000), '40 MB')
check('die Obergrenze liest sich rund', formatBytes(ATTACHMENT_MAX_BYTES), '50 MB')
check('nichts ist nichts', formatBytes(0), '0 B')
check('und Unsinn ist ein Strich', formatBytes(Number.NaN), '—')

// ---------------------------------------------------------------------------
// Die Ablage selbst
//
// Gegen ein Wegwerf-Verzeichnis statt gegen /data, wie bei den Verträgen.
// ---------------------------------------------------------------------------

const root = await mkdtemp(join(tmpdir(), 'soloops-dateien-'))
const bytes = Buffer.from('nicht unbedingt ein PDF')

const erste = await storeAttachmentFile('cl1-2026-10-16-briefing-a.pdf', bytes, root)
check('der Name kommt zurück, wie er reinging', erste, 'cl1-2026-10-16-briefing-a.pdf')
check('und die Bytes liegen unverändert da', await readFile(join(root, erste)), bytes)

await storeAttachmentFile('cl1-2026-10-16-logo-b.png', bytes, root)
check('zwei Uploads, zwei Dateien', (await readdir(root)).length, 2)

check('entfernen entfernt', await removeAttachmentFile(erste, root), true)
check(
  'und meldet beim zweiten Mal, dass nichts mehr da war',
  await removeAttachmentFile(erste, root),
  false,
)
check('nichts zu entfernen ist kein Fehler', await removeAttachmentFile(null, root), false)
check('ein leerer Name ebenso', await removeAttachmentFile('', root), false)
check('übrig bleibt die andere Datei', await readdir(root), ['cl1-2026-10-16-logo-b.png'])

// Die Grenze gilt auch hier, nicht nur beim Lesen.
let refused = false
try {
  await storeAttachmentFile('../entwischt.pdf', bytes, root)
} catch {
  refused = true
}
check('ein Name aus der Ablage heraus wird abgelehnt', refused, true)
check(
  'ein Löschversuch daneben fasst nichts an',
  await removeAttachmentFile('../../etc/passwd', root),
  false,
)
check('und die Ablage ist unverändert', (await readdir(root)).length, 1)

await removeAttachmentFile('cl1-2026-10-16-logo-b.png', root)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
