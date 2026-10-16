import { readCommits, split, type ProviderAccess } from '../src/services/repoCommitRead.js'

/**
 * What the two hosts say about commits, and what soloops makes of it.
 *
 * Against a stubbed `fetch`: the point is not that HTTP works but that the
 * payloads are read correctly — the date a commit is filed under, where the
 * subject stops, and the two answers that mean "no commits here" rather than
 * "something broke".
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
// The stub
// ---------------------------------------------------------------------------

let calls: { url: string; headers: Record<string, string> }[] = []

/** Answer with this body and status, and record what was asked for. */
function stub(body: unknown, status = 200): void {
  calls = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

const ACCESS: ProviderAccess = {
  githubToken: 'gh-test',
  gitlabToken: 'gl-test',
  gitlabHost: 'https://gitlab.example.com/',
}
const SINCE = new Date('2026-10-01T00:00:00.000Z')

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

check('die erste Zeile ist der Betreff', split('feat: Overlay\n\nwarum\nCo-Authored-By: X'), {
  subject: 'feat: Overlay',
  body: 'warum\nCo-Authored-By: X',
})
check('ohne Rumpf bleibt der Rumpf leer', split('fix: Rasten'), {
  subject: 'fix: Rasten',
  body: '',
})

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

stub([
  {
    sha: 'abc1234def',
    html_url: 'https://github.com/pnse/soloops/commit/abc1234def',
    commit: {
      message: 'feat(zeit): Overlay rastet ein\n\nAcht Rastpunkte.',
      author: {
        name: 'Philipp Niestroj',
        email: 'contact@philippniestroj.com',
        date: '2026-10-13T08:00:00Z',
      },
      // Rebased: committed a day after it was written, and that is the date
      // a booking is matched against.
      committer: { name: 'GitHub', email: 'noreply@github.com', date: '2026-10-14T09:30:00Z' },
    },
  },
])

const github = await readCommits('GITHUB', 'pnse/soloops', 'main', SINCE, ACCESS)

check('ein Commit wird zu einer Zeile', github.length, 1)
check(
  'Betreff und Rumpf sind getrennt',
  [github[0]?.subject, github[0]?.body],
  ['feat(zeit): Overlay rastet ein', 'Acht Rastpunkte.'],
)
check(
  'gezählt wird das Committer-Datum, nicht das Autor-Datum',
  github[0]?.committedAt.toISOString(),
  '2026-10-14T09:30:00.000Z',
)
check(
  'der Autor bleibt der Autor, nicht der Committer',
  [github[0]?.authorName, github[0]?.authorEmail],
  ['Philipp Niestroj', 'contact@philippniestroj.com'],
)
check('der Branch steht an der Zeile', github[0]?.branch, 'main')
check(
  'gefragt wird nach Branch und Zeitpunkt',
  calls[0]?.url,
  'https://api.github.com/repos/pnse/soloops/commits?sha=main&since=2026-10-01T00%3A00%3A00.000Z&per_page=100',
)
check(
  'mit Token im Header',
  (calls[0]?.headers as Record<string, string>).Authorization,
  'Bearer gh-test',
)

// Without a committer date the author date has to do.
stub([
  {
    sha: 'f00',
    html_url: 'https://github.com/pnse/soloops/commit/f00',
    commit: {
      message: 'chore: nichts',
      author: { name: 'P', email: 'p@example.com', date: '2026-10-12T07:00:00Z' },
      committer: null,
    },
  },
])
check(
  'ohne Committer-Datum zählt das Autor-Datum',
  (
    await readCommits('GITHUB', 'pnse/soloops', 'main', SINCE, ACCESS)
  )[0]?.committedAt.toISOString(),
  '2026-10-12T07:00:00.000Z',
)

stub({ message: 'Git Repository is empty.' }, 409)
check(
  'ein leeres Repository ist kein Fehler',
  await readCommits('GITHUB', 'pnse/leer', 'main', SINCE, ACCESS),
  [],
)

stub({ message: 'Not Found' }, 404)
check(
  'ein Branch, den es nicht gibt, ist kein Fehler',
  await readCommits('GITHUB', 'pnse/soloops', 'gibtsnicht', SINCE, ACCESS),
  [],
)

stub({ message: 'Bad credentials' }, 401)
let raised = ''
try {
  await readCommits('GITHUB', 'pnse/soloops', 'main', SINCE, ACCESS)
} catch (err) {
  raised = (err as Error).message
}
check('ein falsches Token ist einer', raised, 'GitHub HTTP 401')

stub([])
check(
  'ohne Token wird nicht gefragt',
  await readCommits('GITHUB', 'pnse/soloops', 'main', SINCE, { gitlabHost: 'x' }),
  [],
)
check('und zwar wirklich nicht', calls.length, 0)

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

stub([
  {
    id: 'deadbeef',
    message: 'fix(api): Rechnungslauf\n\nmit Grund.',
    author_name: 'Philipp Niestroj',
    author_email: 'contact@philippniestroj.com',
    committed_date: '2026-10-14T11:00:00+02:00',
    web_url: 'https://gitlab.example.com/pnse/kundenportal/-/commit/deadbeef',
  },
])

const gitlab = await readCommits('GITLAB', 'pnse/nested/kundenportal', 'develop', SINCE, ACCESS)

check(
  'GitLab liefert dieselbe Zeile',
  [gitlab[0]?.sha, gitlab[0]?.subject, gitlab[0]?.body],
  ['deadbeef', 'fix(api): Rechnungslauf', 'mit Grund.'],
)
check(
  'die Zeitzone der Antwort wird umgerechnet',
  gitlab[0]?.committedAt.toISOString(),
  '2026-10-14T09:00:00.000Z',
)
check(
  'der verschachtelte Projektpfad wird kodiert, der Host nicht doppelt geschrägt',
  calls[0]?.url,
  'https://gitlab.example.com/api/v4/projects/pnse%2Fnested%2Fkundenportal/repository/commits?ref_name=develop&since=2026-10-01T00%3A00%3A00.000Z&per_page=100',
)
check(
  'mit Token im GitLab-Header',
  (calls[0]?.headers as Record<string, string>)['PRIVATE-TOKEN'],
  'gl-test',
)

console.log(`\n${pass} ok, ${fail} fehlgeschlagen`)
if (fail) process.exit(1)
