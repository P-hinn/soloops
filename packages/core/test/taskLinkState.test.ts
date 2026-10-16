import { readLinkState, type ProviderAccess } from '../src/services/taskLinkState.js'
import type { ParsedLink } from '../src/services/taskLinks.js'

/**
 * What the two hosts say, and what soloops makes of it.
 *
 * Against a stubbed `fetch`: the point is not that HTTP works but that the
 * payloads are read correctly — an issue number that is really a pull
 * request, and the fact that GitHub says "open", GitLab says "opened", and
 * "merged" is a boolean on one and a state on the other.
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

type Call = { url: string; headers: Record<string, string> }

let calls: Call[] = []

/**
 * Answer the routes given, 404 everything else. The recorded calls are half
 * the assertion: a second request to the pulls endpoint is what tells an
 * issue and a pull request apart, so whether it happened matters.
 */
function stub(routes: Record<string, unknown>): void {
  calls = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const body = routes[url]
    if (body === undefined) {
      return new Response('{"message":"Not Found"}', { status: 404 })
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
}

const ACCESS: ProviderAccess = {
  githubToken: 'gh-test',
  gitlabToken: 'gl-test',
  gitlabHost: 'https://gitlab.example.com',
}

const gh = (kind: ParsedLink['kind'], ref: string): ParsedLink => ({
  provider: 'GITHUB',
  kind,
  repo: 'pnse/soloops',
  ref,
  url: `https://github.com/pnse/soloops/x/${ref}`,
})

const gl = (kind: ParsedLink['kind'], ref: string): ParsedLink => ({
  provider: 'GITLAB',
  kind,
  repo: 'acme/team/web',
  ref,
  url: `https://gitlab.example.com/acme/team/web/-/x/${ref}`,
})

const GH_ISSUE = 'https://api.github.com/repos/pnse/soloops/issues/12'
const GH_PULL = 'https://api.github.com/repos/pnse/soloops/pulls/12'
const GH_COMMIT = 'https://api.github.com/repos/pnse/soloops/commits/abc1234'
const GL_MR = 'https://gitlab.example.com/api/v4/projects/acme%2Fteam%2Fweb/merge_requests/9'
const GL_ISSUE = 'https://gitlab.example.com/api/v4/projects/acme%2Fteam%2Fweb/issues/9'
const GL_COMMIT =
  'https://gitlab.example.com/api/v4/projects/acme%2Fteam%2Fweb/repository/commits/abc1234'

const run = async (link: ParsedLink, access: ProviderAccess = ACCESS) => readLinkState(link, access)

// ---------------------------------------------------------------------------
// No token
//
// The normal state without a PAT, and deliberately not an error: the link is
// still stored, just without a title.
// ---------------------------------------------------------------------------

stub({})
check(
  'ohne GitHub-Token wird nichts gelesen',
  await run(gh('ISSUE', '12'), { gitlabHost: '' }),
  null,
)
check('…und auch nichts angefragt', calls.length, 0)

check(
  'ohne GitLab-Token ebenso',
  await run(gl('PULL_REQUEST', '9'), { githubToken: 'gh', gitlabHost: 'https://gitlab.com' }),
  null,
)
check('…ohne Anfrage', calls.length, 0)

// ---------------------------------------------------------------------------
// GitHub: issue or pull request
// ---------------------------------------------------------------------------

stub({
  [GH_ISSUE]: {
    title: 'Export läuft in einen Timeout',
    state: 'open',
    html_url: 'https://github.com/pnse/soloops/issues/12',
    user: { login: 'pnse' },
  },
})
check('ein Issue bleibt ein Issue', await run(gh('ISSUE', '12')), {
  kind: 'ISSUE',
  url: 'https://github.com/pnse/soloops/issues/12',
  title: 'Export läuft in einen Timeout',
  state: 'open',
  author: 'pnse',
  mergedAt: null,
})
check('ein Issue kostet eine Anfrage', calls.length, 1)
check('das Token geht als Bearer mit', calls[0]?.headers.Authorization, 'Bearer gh-test')

// The case the shorthand `owner/repo#12` cannot know: GitHub numbers issues
// and pull requests in one sequence, and only the payload tells them apart.
stub({
  [GH_ISSUE]: {
    title: 'alt',
    state: 'closed',
    html_url: 'https://github.com/pnse/soloops/issues/12',
    user: { login: 'wer-auch-immer' },
    pull_request: { merged_at: '2026-10-01T10:00:00Z' },
  },
  [GH_PULL]: {
    title: 'fix(export): Timeout hochsetzen',
    state: 'closed',
    html_url: 'https://github.com/pnse/soloops/pull/12',
    draft: false,
    merged: true,
    merged_at: '2026-10-01T10:00:00Z',
    user: { login: 'pnse' },
  },
})
const merged = await run(gh('ISSUE', '12'))
check('aus der Nummer wird ein PR, und zwar ein gemergter', merged, {
  kind: 'PULL_REQUEST',
  url: 'https://github.com/pnse/soloops/pull/12',
  title: 'fix(export): Timeout hochsetzen',
  state: 'merged',
  author: 'pnse',
  mergedAt: new Date('2026-10-01T10:00:00Z'),
})
check('dafür braucht es die zweite Anfrage', [calls.length, calls[1]?.url], [2, GH_PULL])

stub({
  [GH_ISSUE]: { title: 'x', state: 'open', html_url: '', user: null, pull_request: {} },
  [GH_PULL]: {
    title: 'WIP',
    state: 'open',
    html_url: 'https://github.com/pnse/soloops/pull/12',
    draft: true,
    merged: false,
    merged_at: null,
    user: { login: 'pnse' },
  },
})
check('ein Entwurf ist nicht einfach offen', (await run(gh('PULL_REQUEST', '12')))?.state, 'draft')

stub({
  [GH_ISSUE]: { title: 'x', state: 'open', html_url: '', user: null, pull_request: {} },
  [GH_PULL]: {
    title: 'Review bitte',
    state: 'open',
    html_url: 'https://github.com/pnse/soloops/pull/12',
    draft: false,
    merged: false,
    merged_at: null,
    user: { login: 'pnse' },
  },
})
check('ein offener PR', (await run(gh('PULL_REQUEST', '12')))?.state, 'open')

stub({
  [GH_ISSUE]: { title: 'x', state: 'closed', html_url: '', user: null, pull_request: {} },
  [GH_PULL]: {
    title: 'Doch nicht',
    state: 'closed',
    html_url: 'https://github.com/pnse/soloops/pull/12',
    draft: false,
    merged: false,
    merged_at: null,
    user: { login: 'pnse' },
  },
})
check(
  'zugemacht ohne Merge ist nicht dasselbe wie gemerged',
  (await run(gh('PULL_REQUEST', '12')))?.state,
  'closed',
)

// ---------------------------------------------------------------------------
// GitHub: commits
// ---------------------------------------------------------------------------

stub({
  [GH_COMMIT]: {
    sha: 'abc1234',
    html_url: 'https://github.com/pnse/soloops/commit/abc1234',
    commit: {
      message: 'feat(tasks): Board und Liste\n\nMit einer langen Begründung darunter.',
      author: { name: 'Philipp Niestroj' },
    },
    author: { login: 'pnse' },
  },
})
check(
  'ein Commit zeigt die erste Zeile, nicht den ganzen Body',
  await run(gh('COMMIT', 'abc1234')),
  {
    url: 'https://github.com/pnse/soloops/commit/abc1234',
    title: 'feat(tasks): Board und Liste',
    state: null,
    author: 'pnse',
    mergedAt: null,
  },
)

stub({
  [GH_COMMIT]: {
    sha: 'abc1234',
    html_url: 'https://github.com/pnse/soloops/commit/abc1234',
    commit: { message: 'chore: Kleinigkeit', author: { name: 'Jemand Extern' } },
    // Someone who committed without a GitHub account attached to the address.
    author: null,
  },
})
check(
  'ohne GitHub-Konto steht der Name aus dem Commit da',
  (await run(gh('COMMIT', 'abc1234')))?.author,
  'Jemand Extern',
)

// ---------------------------------------------------------------------------
// Errors
//
// They have to come out as a rejection: the route catches them, logs the line
// and stores the link anyway. Swallowing them here would make a 401 from a
// stale token look exactly like a repository with no title.
// ---------------------------------------------------------------------------

stub({})
let message = ''
try {
  await run(gh('ISSUE', '12'))
} catch (err) {
  message = (err as Error).message
}
check('ein 404 wird gemeldet, nicht verschluckt', message, 'GitHub HTTP 404')

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

stub({
  [GL_MR]: {
    title: 'Export beschleunigen',
    state: 'opened',
    web_url: 'https://gitlab.example.com/acme/team/web/-/merge_requests/9',
    draft: false,
    merged_at: null,
    author: { username: 'pnse' },
  },
})
check('„opened" heißt hier wie überall offen', await run(gl('PULL_REQUEST', '9')), {
  url: 'https://gitlab.example.com/acme/team/web/-/merge_requests/9',
  title: 'Export beschleunigen',
  state: 'open',
  author: 'pnse',
  mergedAt: null,
})
check(
  'der eigene Host und der PRIVATE-TOKEN-Header werden benutzt',
  [calls[0]?.url, calls[0]?.headers['PRIVATE-TOKEN']],
  [GL_MR, 'gl-test'],
)

stub({
  [GL_MR]: {
    title: 'Entwurf',
    state: 'opened',
    web_url: '',
    draft: true,
    merged_at: null,
    author: null,
  },
})
check(
  'ein Draft-MR heißt Entwurf, nicht offen',
  (await run(gl('PULL_REQUEST', '9')))?.state,
  'draft',
)

stub({
  [GL_MR]: {
    title: 'Drin',
    state: 'merged',
    web_url: 'https://gitlab.example.com/acme/team/web/-/merge_requests/9',
    draft: false,
    merged_at: '2026-09-30T08:00:00Z',
    author: { username: 'pnse' },
  },
})
const glMerged = await run(gl('PULL_REQUEST', '9'))
check(
  'gemerged kommt bei GitLab als Status, nicht als Boolean',
  [glMerged?.state, glMerged?.mergedAt],
  ['merged', new Date('2026-09-30T08:00:00Z')],
)

stub({
  [GL_ISSUE]: {
    title: 'Ticket',
    state: 'closed',
    web_url: 'https://gitlab.example.com/acme/team/web/-/issues/9',
    author: { username: 'pnse' },
  },
})
check('ein GitLab-Issue greift den anderen Pfad ab', (await run(gl('ISSUE', '9')))?.state, 'closed')

stub({
  [GL_COMMIT]: {
    title: 'fix: Zeitzone\nnoch mehr',
    author_name: 'Philipp Niestroj',
    web_url: 'https://gitlab.example.com/acme/team/web/-/commit/abc1234',
  },
})
check('ein GitLab-Commit', await run(gl('COMMIT', 'abc1234')), {
  url: 'https://gitlab.example.com/acme/team/web/-/commit/abc1234',
  title: 'fix: Zeitzone',
  state: null,
  author: 'Philipp Niestroj',
  mergedAt: null,
})

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
