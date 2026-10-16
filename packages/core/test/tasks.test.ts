import {
  BOARD_COLUMNS,
  columnPatch,
  followUpTaskTitle,
  isFollowUpTask,
  nextPosition,
  POSITION_STEP,
  spreadPositions,
} from '../src/services/tasks.js'
import { parseTaskLink } from '../src/services/taskLinks.js'

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
// The board
//
// The point of these: `done` and `status` must not be able to describe two
// different things. A task is closed or it is in a column, never both.
// ---------------------------------------------------------------------------

check('nach Erledigt verschieben haekt ab und laesst den Status stehen', columnPatch('DONE'), {
  done: true,
})

check('nach Blockiert verschieben oeffnet die Aufgabe wieder', columnPatch('BLOCKED'), {
  done: false,
  status: 'BLOCKED',
})

// The property the whole board rests on: moving into a column either closes
// the task or names a status, never both — so `done` and `status` cannot end
// up describing two different things.
check(
  'keine Spalte setzt beides',
  BOARD_COLUMNS.map((column) => [columnPatch(column).done, columnPatch(column).status ?? null]),
  [
    [false, 'TODO'],
    [false, 'DOING'],
    [false, 'BLOCKED'],
    [true, null],
  ],
)

check('es gibt genau vier Spalten', [...BOARD_COLUMNS], ['TODO', 'DOING', 'BLOCKED', 'DONE'])

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

check('die erste Karte einer Spalte sitzt auf 0', nextPosition([]), 0)

check('eine neue Karte kommt hinter alles Bestehende', nextPosition([0, 1000, 500]), 2000)

check('eine umsortierte Spalte bekommt gleichmaessige Abstaende', spreadPositions(3), [
  0,
  POSITION_STEP,
  2 * POSITION_STEP,
])

check('eine leere Spalte braucht keine Positionen', spreadPositions(0), [])

// ---------------------------------------------------------------------------
// A follow-up and its ticket
//
// The marker decides who owns a card: chasing a lead up ticks off the ticket
// the follow-up made for itself and nothing else. A task you wrote on the
// same lead stays yours, which is the whole reason the source is checked and
// not just the lead.
// ---------------------------------------------------------------------------

check(
  'die Wiedervorlage erkennt ihr eigenes Ticket',
  isFollowUpTask({ source: 'LEAD', leadId: 'l1' }),
  true,
)

check(
  'eine selbst geschriebene Aufgabe am selben Lead gehoert ihr nicht',
  isFollowUpTask({ source: 'MANUAL', leadId: 'l1' }),
  false,
)

check(
  'auch nicht die aus dem Meeting-Protokoll',
  isFollowUpTask({ source: 'AI', leadId: 'l1' }),
  false,
)

check(
  'ein LEAD-Ticket ohne Lead ist keins — der Verweis kann beim Loeschen gefallen sein',
  isFollowUpTask({ source: 'LEAD', leadId: null }),
  false,
)

check(
  'ohne Grund steht nur der Lead auf der Karte',
  followUpTaskTitle('Beispiel GmbH — DWH'),
  'Wiedervorlage: Beispiel GmbH — DWH',
)

check(
  'mit Grund steht erst der Lead da, dann was zu tun ist',
  followUpTaskTitle('Beispiel GmbH', 'Angebot nachfassen'),
  'Wiedervorlage Beispiel GmbH: Angebot nachfassen',
)

check(
  'ein leerer Grund zaehlt als keiner',
  followUpTaskTitle('Beispiel GmbH', '   '),
  'Wiedervorlage: Beispiel GmbH',
)

check('null ebenso', followUpTaskTitle('Beispiel GmbH', null), 'Wiedervorlage: Beispiel GmbH')

// ---------------------------------------------------------------------------
// Links to a repository
//
// The URL is rebuilt from what was parsed, so `/pull/12/files#diff-abc` and
// `/pull/12` are one link rather than two rows on the same task.
// ---------------------------------------------------------------------------

check('ein PR-Link aus dem Browser', parseTaskLink('https://github.com/pnse/soloops/pull/12'), {
  provider: 'GITHUB',
  kind: 'PULL_REQUEST',
  repo: 'pnse/soloops',
  ref: '12',
  url: 'https://github.com/pnse/soloops/pull/12',
})

check(
  'der Tab und der Anker am PR-Link aendern nichts',
  parseTaskLink('https://github.com/pnse/soloops/pull/12/files#diff-abc123'),
  {
    provider: 'GITHUB',
    kind: 'PULL_REQUEST',
    repo: 'pnse/soloops',
    ref: '12',
    url: 'https://github.com/pnse/soloops/pull/12',
  },
)

check(
  'ein Commit-Link, Sha klein geschrieben',
  parseTaskLink('https://github.com/pnse/soloops/commit/A1B2C3D4E5F6'),
  {
    provider: 'GITHUB',
    kind: 'COMMIT',
    repo: 'pnse/soloops',
    ref: 'a1b2c3d4e5f6',
    url: 'https://github.com/pnse/soloops/commit/a1b2c3d4e5f6',
  },
)

check('ein Issue-Link', parseTaskLink('https://github.com/pnse/soloops/issues/7'), {
  provider: 'GITHUB',
  kind: 'ISSUE',
  repo: 'pnse/soloops',
  ref: '7',
  url: 'https://github.com/pnse/soloops/issues/7',
})

check(
  'die Kurzform mit Raute — Issue, bis das Nachlesen es besser weiss',
  parseTaskLink('pnse/soloops#42'),
  {
    provider: 'GITHUB',
    kind: 'ISSUE',
    repo: 'pnse/soloops',
    ref: '42',
    url: 'https://github.com/pnse/soloops/issues/42',
  },
)

check('die Kurzform mit Klammeraffe ist ein Commit', parseTaskLink('pnse/soloops@abc1234'), {
  provider: 'GITHUB',
  kind: 'COMMIT',
  repo: 'pnse/soloops',
  ref: 'abc1234',
  url: 'https://github.com/pnse/soloops/commit/abc1234',
})

check(
  'ein Merge Request bei GitLab, Projektpfad mehrere Gruppen tief',
  parseTaskLink('https://gitlab.com/acme/team/web/-/merge_requests/9'),
  {
    provider: 'GITLAB',
    kind: 'PULL_REQUEST',
    repo: 'acme/team/web',
    ref: '9',
    url: 'https://gitlab.com/acme/team/web/-/merge_requests/9',
  },
)

check(
  'ein GitLab-Commit',
  parseTaskLink('https://gitlab.com/acme/web/-/commit/0f1e2d3c4b5a69788'),
  {
    provider: 'GITLAB',
    kind: 'COMMIT',
    repo: 'acme/web',
    ref: '0f1e2d3c4b5a69788',
    url: 'https://gitlab.com/acme/web/-/commit/0f1e2d3c4b5a69788',
  },
)

// What must not parse: a link stored without a usable ref would show up as a
// chip that leads nowhere.
check(
  'die Repo-Startseite ist kein Link auf etwas',
  parseTaskLink('https://github.com/pnse/soloops'),
  null,
)

check(
  'ein Release ist nichts, womit eine Aufgabe umgehen kann',
  parseTaskLink('https://github.com/pnse/soloops/releases/tag/v1'),
  null,
)

check(
  'eine PR-Nummer, die keine ist',
  parseTaskLink('https://github.com/pnse/soloops/pull/abc'),
  null,
)

check('ein Sha, der keiner ist', parseTaskLink('https://github.com/pnse/soloops/commit/zzzz'), null)

check('ein fremder Host', parseTaskLink('https://bitbucket.org/pnse/soloops/pull/1'), null)

// The shorthand has no URL parser in front of it to normalise `..` away, so
// it has to be strict itself: owner and repository, one segment each.
check('die Kurzform nimmt keine Pfade', parseTaskLink('pnse/../../orgs/anthropic#1'), null)
check('und auch keine drei Ebenen', parseTaskLink('a/b/c#5'), null)
check(
  'ein Punkt im Repo-Namen ist dagegen normal',
  parseTaskLink('pnse/so.loops#3')?.repo,
  'pnse/so.loops',
)

check('leer bleibt leer', parseTaskLink('   '), null)

check('kein Link, nur Text', parseTaskLink('mach mal den PR fertig'), null)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
