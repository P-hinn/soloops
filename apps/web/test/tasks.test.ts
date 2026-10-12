import {
  columnOf,
  COLUMNS,
  daysUntil,
  dueLabel,
  hours,
  linkBadgeClass,
  linkLabel,
  type Task,
  type TaskLink,
} from '../src/lib/tasks.js'

/**
 * The wording on a card.
 *
 * Plain tsx like the API's tests, no test runner: everything in here is a
 * pure function over a date or a string, and a frontend runner would be a
 * dependency bought for seven of them.
 *
 * The deadline cases are the reason this file exists. "heute" against
 * "morgen" is a day boundary, not a 24-hour distance — a task due this
 * evening and one due tomorrow morning are twelve hours apart and have to
 * read differently.
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

/** A due date `days` from today, at the given local hour. */
function due(days: number, hour = 12): string {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour).toISOString()
}

// ---------------------------------------------------------------------------
// Days to the deadline
// ---------------------------------------------------------------------------

check('heute ist null Tage hin', daysUntil(due(0)), 0)
check('die letzte Stunde von heute ist immer noch heute', daysUntil(due(0, 23)), 0)
check('die erste Stunde von heute auch', daysUntil(due(0, 0)), 0)
check('morgen früh ist einen Tag hin, nicht null', daysUntil(due(1, 1)), 1)
check('gestern spät ist einen Tag her, nicht null', daysUntil(due(-1, 23)), -1)
check('über einen Monatswechsel wird trotzdem gezählt', daysUntil(due(40)), 40)

// ---------------------------------------------------------------------------
// How it reads
// ---------------------------------------------------------------------------

check('überfällig steht in Tagen da, nicht als Datum', dueLabel(due(-3)), {
  text: '3 T über',
  tone: 'bad',
})
check('einen Tag drüber', dueLabel(due(-1)), { text: '1 T über', tone: 'bad' })
check('heute ist so dringend wie überfällig', dueLabel(due(0)), { text: 'heute', tone: 'bad' })
check('morgen hat einen eigenen Namen', dueLabel(due(1)), { text: 'morgen', tone: 'warn' })
check('innerhalb der Woche bleibt es relativ', dueLabel(due(5)), { text: 'in 5 T', tone: 'warn' })
check('der siebte Tag gehört noch zur Woche', dueLabel(due(7)).tone, 'warn')
check('ab dem achten steht das Datum da', dueLabel(due(8)).tone, 'muted')
check(
  'und zwar als Tag.Monat',
  dueLabel(due(8)).text,
  new Date(due(8)).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
)

// ---------------------------------------------------------------------------
// The column
//
// The one rule the whole board rests on: `done` wins over `status`, and the
// status survives untouched underneath it.
// ---------------------------------------------------------------------------

const task = (done: boolean, status: Task['status']): Task =>
  ({ id: 'x', title: 't', done, status }) as Task

check('offen steht in seiner Statusspalte', columnOf(task(false, 'DOING')), 'DOING')
check('blockiert ebenso', columnOf(task(false, 'BLOCKED')), 'BLOCKED')
check(
  'abgehakt steht in Erledigt, egal was der Status sagt',
  columnOf(task(true, 'BLOCKED')),
  'DONE',
)
check(
  'die vier Spalten stehen in Arbeitsrichtung',
  COLUMNS.map((c) => c.key),
  ['TODO', 'DOING', 'BLOCKED', 'DONE'],
)

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

const link = (kind: TaskLink['kind'], ref: string, state: string | null = null): TaskLink =>
  ({ kind, ref, state }) as TaskLink

check(
  'ein Commit zeigt sieben Stellen vom Sha',
  linkLabel(link('COMMIT', 'a1b2c3d4e5f6a7b8')),
  'a1b2c3d',
)
check('ein kurzer Sha bleibt, wie er ist', linkLabel(link('COMMIT', 'abc12')), 'abc12')
check('ein PR zeigt seine Nummer', linkLabel(link('PULL_REQUEST', '12')), 'PR #12')
check('ein Issue auch', linkLabel(link('ISSUE', '7')), 'Issue #7')

check('gemerged ist gut', linkBadgeClass(link('PULL_REQUEST', '1', 'merged')), 'badge-good')
check(
  'ein zugemachter PR ohne Merge ist es nicht',
  linkBadgeClass(link('PULL_REQUEST', '1', 'closed')),
  'badge-bad',
)
check(
  'ein geschlossenes Issue dagegen schon — da heißt zu auch erledigt',
  linkBadgeClass(link('ISSUE', '1', 'closed')),
  'badge-good',
)
check(
  'ein Entwurf ist eine Warnung',
  linkBadgeClass(link('PULL_REQUEST', '1', 'draft')),
  'badge-warn',
)
check('offen ist neutral', linkBadgeClass(link('PULL_REQUEST', '1', 'open')), 'badge-blue')
check('ohne Token gibt es keinen Status und keine Farbe', linkBadgeClass(link('COMMIT', 'abc')), '')

// ---------------------------------------------------------------------------
// Erfasste Zeit
// ---------------------------------------------------------------------------

check('nichts erfasst', hours(0), '0:00 h')
check('eine runde Stunde', hours(3600), '1:00 h')
check('anderthalb', hours(5400), '1:30 h')
check('angefangene Minuten zählen nicht hoch', hours(59), '0:00 h')
check('zweistellige Minuten bleiben zweistellig', hours(3600 + 5 * 60), '1:05 h')
check('über den Tag hinaus wird weitergezählt, nicht umgebrochen', hours(26 * 3600), '26:00 h')

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
