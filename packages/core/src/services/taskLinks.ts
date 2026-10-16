import type { RepoProvider, TaskLinkKind } from '@prisma/client'

/**
 * A task's references into a repository.
 *
 * What goes in is whatever is in the clipboard — a PR URL from the browser, a
 * commit URL, or the `owner/repo#123` shorthand. What comes out is the four
 * things worth storing: who hosts it, what kind of thing it is, which repo,
 * and the number or sha. The URL is rebuilt from those rather than kept
 * verbatim, so `/pull/12/files#diff-abc` and `/pull/12` are recognised as the
 * same link instead of landing twice on the same task.
 *
 * Nothing in here talks to a network or reads the configuration — that is
 * services/taskLinkState.ts. Parsing a URL is the part worth having tests
 * for, and tests that need a database connection to check a regular
 * expression do not get written.
 */

export type ParsedLink = {
  provider: RepoProvider
  kind: TaskLinkKind
  /** owner/repo on GitHub, group/project (possibly nested) on GitLab. */
  repo: string
  /** Issue or PR number, or the commit sha. */
  ref: string
  url: string
}

const SHA = /^[0-9a-f]{7,40}$/i

/** GitHub path segment -> kind. */
const GITHUB_KINDS: Record<string, TaskLinkKind> = {
  pull: 'PULL_REQUEST',
  issues: 'ISSUE',
  commit: 'COMMIT',
  commits: 'COMMIT',
}

/** GitLab's paths live behind `/-/`. */
const GITLAB_KINDS: Record<string, TaskLinkKind> = {
  merge_requests: 'PULL_REQUEST',
  issues: 'ISSUE',
  commit: 'COMMIT',
}

/** Where a self-hosted GitLab lives, when it is not gitlab.com. */
export const DEFAULT_GITLAB_HOST = 'https://gitlab.com'

export function parseTaskLink(input: string, gitlabHost = DEFAULT_GITLAB_HOST): ParsedLink | null {
  const text = input.trim()
  if (!text) return null
  return text.includes('://') ? fromUrl(text, gitlabHost) : fromShorthand(text)
}

/**
 * `owner/repo#123` and `owner/repo@sha`.
 *
 * `#123` stays an ISSUE here even though it is more often a pull request:
 * GitHub numbers both in one sequence and the shorthand cannot tell them
 * apart. Reading the state corrects it on the first try, which is the only
 * place that can actually know.
 */
function fromShorthand(text: string): ParsedLink | null {
  // Owner and repository, each one segment. Letting the repository part hold
  // slashes would accept `pnse/../../orgs/x#1`, which reads as a repository,
  // stores as nonsense, and resolves against api.github.com as an entirely
  // different endpoint once fetch normalises the path away.
  const match = /^([\w.-]+)\/([\w.-]+?)(?:#(\d+)|@([0-9a-f]{7,40}))$/i.exec(text)
  if (!match) return null
  const [, owner, repo, number, sha] = match
  const slug = `${owner}/${repo}`
  if (number) return github('ISSUE', slug, number)
  return github('COMMIT', slug, sha!.toLowerCase())
}

function fromUrl(text: string, gitlabHost: string): ParsedLink | null {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 4) return null

  const host = url.hostname.toLowerCase()

  // GitLab puts everything behind `/-/`, and the project path in front of it
  // may be nested several groups deep.
  const dash = segments.indexOf('-')
  if (dash > 0 && (host === 'gitlab.com' || host === hostOf(gitlabHost))) {
    const kind = GITLAB_KINDS[segments[dash + 1] ?? '']
    const ref = segments[dash + 2]
    if (!kind || !ref) return null
    return gitlab(kind, segments.slice(0, dash).join('/'), normaliseRef(kind, ref), gitlabHost)
  }

  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo, type, ref] = segments
    const kind = GITHUB_KINDS[type ?? '']
    if (!owner || !repo || !kind || !ref) return null
    return github(kind, `${owner}/${repo}`, normaliseRef(kind, ref))
  }

  return null
}

/** The host out of a configured base URL, for comparing against a link. */
function hostOf(base: string): string {
  try {
    return new URL(base).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function normaliseRef(kind: TaskLinkKind, ref: string): string {
  return kind === 'COMMIT' ? ref.toLowerCase() : ref
}

function github(kind: TaskLinkKind, repo: string, ref: string): ParsedLink | null {
  if (!isValidRef(kind, ref)) return null
  const path =
    kind === 'COMMIT' ? `commit/${ref}` : kind === 'PULL_REQUEST' ? `pull/${ref}` : `issues/${ref}`
  return { provider: 'GITHUB', kind, repo, ref, url: `https://github.com/${repo}/${path}` }
}

function gitlab(
  kind: TaskLinkKind,
  repo: string,
  ref: string,
  gitlabHost: string,
): ParsedLink | null {
  if (!isValidRef(kind, ref)) return null
  const path =
    kind === 'COMMIT'
      ? `commit/${ref}`
      : kind === 'PULL_REQUEST'
        ? `merge_requests/${ref}`
        : `issues/${ref}`
  const base = gitlabHost.replace(/\/+$/, '')
  return { provider: 'GITLAB', kind, repo, ref, url: `${base}/${repo}/-/${path}` }
}

function isValidRef(kind: TaskLinkKind, ref: string): boolean {
  return kind === 'COMMIT' ? SHA.test(ref) : /^\d+$/.test(ref)
}
