import {
  commitsInWindow,
  composeSummary,
  isMergeCommit,
  readableSubject,
  type CommitRow,
} from '../src/services/timeNarrative.js'

/**
 * What a booking says was done.
 *
 * The two things worth getting wrong are in here: which commits still count
 * as part of a window, and what a client ends up reading on the invoice. Both
 * are arithmetic and string work, so neither needs a database.
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

const T0 = Date.parse('2026-10-14T09:00:00.000Z')
const WINDOW = { startedAt: new Date(T0), endedAt: new Date(T0 + 2 * 3600_000) }

/** One commit, `min` minutes after nine. */
const commit = (min: number, subject: string, extra: Partial<CommitRow> = {}): CommitRow => ({
  sha: `${min}`.padStart(40, 'a'),
  subject,
  authorEmail: 'contact@philippniestroj.com',
  committedAt: new Date(T0 + min * 60_000),
  repoSlug: 'pnse/soloops',
  ...extra,
})

const subjects = (rows: CommitRow[]) => rows.map((row) => row.subject)

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

check(
  'was während der Buchung passiert ist, zählt',
  subjects(
    commitsInWindow([commit(30, 'drin'), commit(600, 'draußen')], WINDOW, {
      toleranceMin: 0,
    }),
  ),
  ['drin'],
)

check(
  'der Push nach dem Stoppen zählt noch, der eine Stunde später nicht',
  subjects(
    commitsInWindow([commit(125, 'kurz danach'), commit(180, 'viel später')], WINDOW, {
      toleranceMin: 10,
    }),
  ),
  ['kurz danach'],
)

check(
  'die Toleranz gilt auch vor dem Start',
  subjects(
    commitsInWindow([commit(-5, 'vorher'), commit(-30, 'lange vorher')], WINDOW, {
      toleranceMin: 10,
    }),
  ),
  ['vorher'],
)

check(
  'ohne Autorenliste zählen alle',
  subjects(
    commitsInWindow(
      [commit(10, 'ich'), commit(20, 'jemand', { authorEmail: 'bot@example.com' })],
      WINDOW,
      {
        toleranceMin: 10,
      },
    ),
  ),
  ['ich', 'jemand'],
)

check(
  'mit Autorenliste zählt nur, wer drinsteht — Großschreibung egal',
  subjects(
    commitsInWindow(
      [commit(10, 'ich'), commit(20, 'bot', { authorEmail: 'bot@example.com' })],
      WINDOW,
      { toleranceMin: 10, authors: [' Contact@PhilippNiestroj.com ', ''] },
    ),
  ),
  ['ich'],
)

check(
  'ein Merge gehört zu keiner Buchung — sonst zählt das Widget zwei und schreibt einen',
  subjects(
    commitsInWindow(
      [commit(10, 'Merge pull request #12 from pnse/zeit'), commit(20, 'fix: Timer stoppt')],
      WINDOW,
      { toleranceMin: 10 },
    ),
  ),
  ['fix: Timer stoppt'],
)

check('Merge branch zählt auch nicht', isMergeCommit('Merge branch main into zeit'), true)
check(
  'ein Satz über Zusammenführungen schon',
  isMergeCommit('fix: Merge-Konflikte aufgeräumt'),
  false,
)

check(
  'die Reihenfolge folgt dem Tag, nicht der Leseordnung',
  subjects(commitsInWindow([commit(90, 'spät'), commit(5, 'früh')], WINDOW, { toleranceMin: 0 })),
  ['früh', 'spät'],
)

// ---------------------------------------------------------------------------
// The subject
// ---------------------------------------------------------------------------

check(
  'der Typ fliegt, der Geltungsbereich bleibt',
  readableSubject('feat(ios): Zeilen mit Inhalt'),
  'ios: Zeilen mit Inhalt',
)
check(
  'ohne Geltungsbereich bleibt nur die Aussage',
  readableSubject('docs: ein lesbares Readme'),
  'ein lesbares Readme',
)
check(
  'das Ausrufezeichen für Breaking Changes stört nicht',
  readableSubject('refactor(api)!: Felder umbenannt'),
  'api: Felder umbenannt',
)
check(
  'ein gewöhnlicher Satz bleibt, wie er ist',
  readableSubject('Rechnungslauf gegen lexoffice gestellt'),
  'Rechnungslauf gegen lexoffice gestellt',
)

// ---------------------------------------------------------------------------
// The line
// ---------------------------------------------------------------------------

check('ohne Commits kein Text', composeSummary([]), '')

check(
  'derselbe Betreff steht nur einmal da',
  composeSummary([commit(5, 'fix: Timer stoppt'), commit(10, 'fix: Timer stoppt')]),
  'Timer stoppt',
)

check(
  'ein Repo braucht keinen Namen auf jeder Zeile',
  composeSummary([commit(5, 'feat: Overlay'), commit(10, 'fix: Rasten')]),
  'Overlay; Rasten',
)

check(
  'bei zwei Repos sagt der Name, wo gearbeitet wurde',
  composeSummary([
    commit(5, 'feat: Overlay'),
    commit(10, 'fix: Rasten', { repoSlug: 'pnse/kundenportal' }),
  ]),
  'soloops: Overlay; kundenportal: Rasten',
)

check(
  'was nicht mehr passt, wird gezählt statt abgeschnitten',
  composeSummary(
    [commit(5, 'eins zwei drei'), commit(10, 'vier fünf sechs'), commit(15, 'sieben acht')],
    { maxChars: 20 },
  ),
  'eins zwei drei (+2 weitere)',
)

check(
  'der erste Betreff bleibt auch dann drin, wenn er allein zu lang ist',
  composeSummary([commit(5, 'ein sehr ausführlich formulierter Betreff')], { maxChars: 10 }),
  'ein sehr ausführlich formulierter Betreff',
)

console.log(`\n${pass} ok, ${fail} fehlgeschlagen`)
if (fail) process.exit(1)
