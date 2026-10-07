import {
  EVENT_WIRE,
  buildPayload,
  eventFromWire,
  matchTriggers,
} from '../src/services/automationEvents.js'
// From automationMath.ts rather than through the services that re-export it:
// those pull in Prisma and env, and none of this needs a database.
import {
  MAX_ATTEMPTS,
  backoffMs,
  failStreakOf,
  health,
  parseSessionCookie,
  runStatus,
  shouldRetry,
  sign,
  verifySignature,
} from '../src/services/automationMath.js'
import { hashToken, mintToken, prefixOf } from '../src/services/automationTokens.js'
import { templates } from '../src/automations/templates.js'

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
// The wire names
// ---------------------------------------------------------------------------
//
// These travel into workflow graphs soloops cannot refactor. The round trip is
// pinned so a rename cannot slip through quietly.

check('jedes Event hat einen Drahtnamen', Object.keys(EVENT_WIRE).length, 9)

check(
  'jeder Drahtname findet zurück zum Enum',
  Object.entries(EVENT_WIRE).every(([event, wire]) => eventFromWire(wire) === event),
  true,
)

check('ein unbekannter Drahtname wird nicht geraten', eventFromWire('lead.exploded'), null)

check('die Drahtnamen sind die dokumentierten', EVENT_WIRE.LEAD_STAGE_CHANGED, 'lead.stage_changed')

check(
  'die Wiedervorlage hat ihren eigenen Drahtnamen',
  EVENT_WIRE.LEAD_FOLLOW_UP_DUE,
  'lead.follow_up_due',
)

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

const now = new Date('2026-10-07T09:30:00.000Z')

check(
  'der Umschlag trägt Event, Zeit und Nutzlast',
  buildPayload(
    { event: 'LEAD_WON', projectId: 'p1', path: '/leads/abc', data: { id: 'abc' } },
    { now, appUrl: 'http://localhost:5174' },
  ),
  {
    event: 'lead.won',
    at: '2026-10-07T09:30:00.000Z',
    projectId: 'p1',
    url: 'http://localhost:5174/leads/abc',
    data: { id: 'abc' },
  },
)

check(
  'ein doppelter Schrägstrich entsteht nicht',
  buildPayload(
    { event: 'LEAD_WON', path: '/leads/abc', data: {} },
    { now, appUrl: 'http://localhost:5174/' },
  ).url,
  'http://localhost:5174/leads/abc',
)

check(
  'ohne Pfad gibt es keine URL, nicht die nackte Basis',
  buildPayload({ event: 'NOTE_CREATED', data: {} }, { now, appUrl: 'http://localhost:5174' }).url,
  null,
)

check(
  'ohne Projekt steht dort null, nicht undefined',
  buildPayload({ event: 'NOTE_CREATED', data: {} }, { now, appUrl: 'http://x' }).projectId,
  null,
)

// ---------------------------------------------------------------------------
// Which triggers an event reaches
// ---------------------------------------------------------------------------

const trigger = (
  id: string,
  event: Parameters<typeof matchTriggers>[1],
  projectId: string | null,
  enabled = true,
) => ({ id, event, projectId, enabled })

const triggers = [
  trigger('global', 'LEAD_WON', null),
  trigger('scoped', 'LEAD_WON', 'p1'),
  trigger('other-project', 'LEAD_WON', 'p2'),
  trigger('other-event', 'LEAD_LOST', null),
  trigger('switched-off', 'LEAD_WON', null, false),
]

check(
  'ein Event aus dem Projekt erreicht den globalen und den passenden Trigger',
  matchTriggers(triggers, 'LEAD_WON', 'p1').map((t) => t.id),
  ['global', 'scoped'],
)

check(
  'ein Event ohne Projekt erreicht nur den globalen Trigger',
  matchTriggers(triggers, 'LEAD_WON', null).map((t) => t.id),
  ['global'],
)

check(
  'ein anderes Projekt erreicht den fremd eingeschränkten Trigger nicht',
  matchTriggers(triggers, 'LEAD_WON', 'p3').map((t) => t.id),
  ['global'],
)

check(
  'ein abgeschalteter Trigger bekommt nichts',
  matchTriggers(triggers, 'LEAD_WON', 'p1').some((t) => t.id === 'switched-off'),
  false,
)

check(
  'ein anderes Event erreicht niemanden von denen',
  matchTriggers(triggers, 'TASK_COMPLETED', null),
  [],
)

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

check('der erste Versuch wartet nicht', backoffMs(1), 0)
check(
  'die Abstände werden größer',
  [backoffMs(2), backoffMs(3), backoffMs(4)],
  [30_000, 120_000, 600_000],
)
check('jenseits der Liste bleibt es beim größten Abstand', backoffMs(99), 600_000)

check('ein Netzfehler ist einen zweiten Versuch wert', shouldRetry(null, 1), true)
check('ein 500er auch', shouldRetry(503, 1), true)
check('ein 429 auch — das ist ein "später", kein "nein"', shouldRetry(429, 1), true)
check('ein 408 auch', shouldRetry(408, 1), true)
check('ein 404 nicht — der Workflow ist weg', shouldRetry(404, 1), false)
check('ein 400 nicht — die Nutzlast wird nicht besser', shouldRetry(400, 1), false)
check('ein 401 nicht — das Token wird nicht gültiger', shouldRetry(401, 1), false)

check('nach dem letzten erlaubten Versuch ist Schluss', shouldRetry(503, MAX_ATTEMPTS), false)

check('vier Versuche insgesamt', MAX_ATTEMPTS, 4)

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

const body = JSON.stringify({ event: 'lead.won', data: { id: 'abc' } })

check('dieselbe Nutzlast ergibt dieselbe Signatur', sign('s3cret', body), sign('s3cret', body))

check(
  'ein anderes Secret ergibt eine andere Signatur',
  sign('s3cret', body) === sign('other', body),
  false,
)

check(
  'die eigene Signatur wird akzeptiert',
  verifySignature('s3cret', body, sign('s3cret', body)),
  true,
)

check(
  'eine veränderte Nutzlast fällt auf',
  verifySignature('s3cret', body.replace('abc', 'xyz'), sign('s3cret', body)),
  false,
)

check(
  'eine zu kurze Signatur wird nicht verglichen',
  verifySignature('s3cret', body, 'deadbeef'),
  false,
)

// ---------------------------------------------------------------------------
// The n8n session cookie
// ---------------------------------------------------------------------------
//
// This is what spares the second login: soloops signs in for you and relays
// the cookie. Every part of reading it back out is a quiet trap.

check(
  'die Sitzung wird aus mehreren Set-Cookie-Zeilen herausgesucht',
  parseSessionCookie(
    ['sonstwas=egal; Path=/', 'n8n-auth=abc123; Path=/; HttpOnly; Max-Age=604800'],
    'n8n-auth',
  ),
  { token: 'abc123', maxAge: 604800 },
)

check(
  'der Wert endet am Semikolon, nicht am Zeilenende',
  parseSessionCookie(['n8n-auth=abc123; Path=/; HttpOnly'], 'n8n-auth')?.token,
  'abc123',
)

check(
  'ohne Max-Age bleibt die Laufzeit offen statt geraten',
  parseSessionCookie(['n8n-auth=abc123; Path=/'], 'n8n-auth')?.maxAge,
  null,
)

check(
  'Max-Age wird unabhaengig von der Schreibweise gelesen',
  parseSessionCookie(['n8n-auth=abc; max-age=42'], 'n8n-auth')?.maxAge,
  42,
)

check(
  'ein geloeschtes Cookie ist keine Sitzung',
  parseSessionCookie(['n8n-auth=; Path=/; Max-Age=0'], 'n8n-auth'),
  null,
)

check(
  'ein negatives Max-Age zaehlt nicht als Laufzeit',
  parseSessionCookie(['n8n-auth=abc; Max-Age=-1'], 'n8n-auth')?.maxAge,
  null,
)

check('fehlt das Cookie, kommt null', parseSessionCookie(['anderes=x'], 'n8n-auth'), null)

check('ohne Set-Cookie-Zeilen kommt null', parseSessionCookie([], 'n8n-auth'), null)

check(
  'ein Name, der nur anfaengt wie unserer, wird nicht verwechselt',
  parseSessionCookie(['n8n-auth-extra=fremd; Path=/'], 'n8n-auth'),
  null,
)

// ---------------------------------------------------------------------------
// n8n's execution status onto ours
// ---------------------------------------------------------------------------

check('erfolgreich', runStatus({ id: 1, status: 'success' }), 'SUCCESS')
check('gescheitert', runStatus({ id: 1, status: 'error' }), 'ERROR')
check('abgestürzt zählt als gescheitert', runStatus({ id: 1, status: 'crashed' }), 'ERROR')
check('läuft noch', runStatus({ id: 1, status: 'running' }), 'RUNNING')
check('wartet', runStatus({ id: 1, status: 'waiting' }), 'WAITING')
check('abgebrochen', runStatus({ id: 1, status: 'canceled' }), 'CANCELED')

// Older instances reported a boolean instead of a status string.
check('ohne Status, aber fertig: erfolgreich', runStatus({ id: 1, finished: true }), 'SUCCESS')
check(
  'ohne Status, gestoppt und nicht fertig: gescheitert',
  runStatus({ id: 1, finished: false, stoppedAt: '2026-10-07T09:00:00Z' }),
  'ERROR',
)
check(
  'gestartet und nicht gestoppt: läuft',
  runStatus({ id: 1, startedAt: '2026-10-07T09:00:00Z' }),
  'RUNNING',
)
check(
  'ein unbekannter Status wird nicht zu einem Fehler geraten',
  runStatus({ id: 1, status: 'something-new' }),
  'UNKNOWN',
)
check('gar keine Angabe bleibt unklar', runStatus({ id: 1 }), 'UNKNOWN')

// ---------------------------------------------------------------------------
// How a flow is doing
// ---------------------------------------------------------------------------

check(
  'in n8n gelöscht schlägt alles andere',
  health({ missingSince: new Date(), failStreak: 3, lastStatus: 'ERROR' }),
  'missing',
)
check(
  'eine Fehlerserie ist der nächstwichtigste Zustand',
  health({ missingSince: null, failStreak: 2, lastStatus: 'SUCCESS' }),
  'failing',
)
check(
  'noch nie gelaufen ist kein Fehler',
  health({ missingSince: null, failStreak: 0, lastStatus: null }),
  'idle',
)
check('sonst läuft es', health({ missingSince: null, failStreak: 0, lastStatus: 'SUCCESS' }), 'ok')

check(
  'die Fehlerserie zählt vom neuesten Lauf nach hinten',
  failStreakOf([
    { status: 'ERROR' },
    { status: 'ERROR' },
    { status: 'SUCCESS' },
    { status: 'ERROR' },
  ]),
  2,
)

check(
  'ein Erfolg an der Spitze setzt die Serie zurück',
  failStreakOf([{ status: 'SUCCESS' }, { status: 'ERROR' }, { status: 'ERROR' }]),
  0,
)

check(
  'ein laufender Lauf verdeckt die Serie darunter nicht',
  failStreakOf([{ status: 'RUNNING' }, { status: 'ERROR' }, { status: 'ERROR' }]),
  2,
)

check(
  'ein wartender Lauf zählt auch nicht als Erfolg',
  failStreakOf([{ status: 'WAITING' }, { status: 'ERROR' }]),
  1,
)

check('ohne Läufe gibt es keine Serie', failStreakOf([]), 0)

check(
  'ein Abbruch beendet die Serie — das war kein Fehler',
  failStreakOf([{ status: 'CANCELED' }, { status: 'ERROR' }]),
  0,
)

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const token = mintToken()

check('ein Token trägt das Präfix', token.startsWith('slp_'), true)
check('zwei Token sind nie gleich', mintToken() === mintToken(), false)
check('derselbe Token ergibt denselben Hash', hashToken(token), hashToken(token))
check('der Hash gibt den Token nicht her', hashToken(token).includes(token.slice(4)), false)
check('das Präfix ist kurz genug, um nichts zu verraten', prefixOf(token).length, 10)
check('und lang genug, um Token zu unterscheiden', prefixOf(token).startsWith('slp_'), true)

// ---------------------------------------------------------------------------
// The bundled templates
// ---------------------------------------------------------------------------
//
// A template that n8n refuses on import is only noticed by hand, and only
// after clicking. These checks are what keeps the gallery honest.

check('es gibt Vorlagen', templates.length > 0, true)

check(
  'jede Vorlage hat einen eigenen Slug',
  new Set(templates.map((t) => t.slug)).size,
  templates.length,
)

check(
  'jede Vorlage hat einen eigenen Namen',
  new Set(templates.map((t) => t.workflow.name)).size,
  templates.length,
)

check(
  'jede Vorlage hat mindestens zwei Nodes',
  templates.every((t) => t.workflow.nodes.length >= 2),
  true,
)

check(
  'jeder Knotenname in den Verbindungen existiert auch als Node',
  templates.every((t) => {
    const names = new Set(t.workflow.nodes.map((n) => n.name))
    return Object.entries(t.workflow.connections).every(([from, value]) => {
      if (!names.has(from)) return false
      const main = (value as { main: { node: string }[][] }).main
      return main.every((branch) => branch.every((target) => names.has(target.node)))
    })
  }),
  true,
)

check(
  'jede Vorlage hat genau einen Trigger',
  templates.every(
    (t) =>
      t.workflow.nodes.filter(
        (n) => n.type.endsWith('soloopsTrigger') || n.type.includes('scheduleTrigger'),
      ).length === 1,
  ),
  true,
)

check(
  'der Trigger ist der erste Knoten und hängt an keinem anderen',
  templates.every((t) => {
    const trigger = t.workflow.nodes.find(
      (n) => n.type.endsWith('soloopsTrigger') || n.type.includes('scheduleTrigger'),
    )
    if (!trigger) return false
    const targets = Object.values(t.workflow.connections).flatMap((value) =>
      (value as { main: { node: string }[][] }).main.flatMap((branch) => branch.map((x) => x.node)),
    )
    return !targets.includes(trigger.name)
  }),
  true,
)

check(
  'jedes Trigger-Event ist eines, das soloops wirklich schickt',
  templates
    .flatMap((t) => t.workflow.nodes)
    .filter((n) => n.type.endsWith('soloopsTrigger'))
    .every((n) => eventFromWire(String(n.parameters?.event)) !== null),
  true,
)

check(
  'jeder soloops-Knoten kommt aus unserem Paket',
  templates
    .flatMap((t) => t.workflow.nodes)
    .filter((n) => n.type.toLowerCase().includes('soloops'))
    .every((n) => n.type.startsWith('n8n-nodes-soloops.')),
  true,
)

check(
  'jede Vorlage legt die Ausführungsreihenfolge fest',
  templates.every((t) => t.workflow.settings?.executionOrder === 'v1'),
  true,
)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
