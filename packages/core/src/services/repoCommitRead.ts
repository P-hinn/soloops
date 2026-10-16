import type { RepoProvider } from '@prisma/client'

/**
 * What GitHub and GitLab say about the commits of a branch.
 *
 * Separate from the mirror next door because this half needs tokens and a
 * network and the other half needs a database. The credentials arrive as an
 * argument rather than out of `env`, so the part worth getting wrong can be
 * exercised against a stubbed `fetch`: which of the two dates a commit is
 * filed under, and where a message stops being a subject.
 *
 * Read-only. Nothing in here writes to a repository.
 */

export type ProviderAccess = {
  githubToken?: string
  gitlabToken?: string
  /** Base URL of the GitLab instance, e.g. `https://gitlab.com`. */
  gitlabHost: string
}

export type CommitRow = {
  sha: string
  subject: string
  body: string
  authorName: string
  authorEmail: string
  url: string
  branch: string
  committedAt: Date
}

type GhCommit = {
  sha: string
  html_url: string
  commit: {
    message: string
    author: { name?: string; email?: string; date?: string } | null
    committer: { name?: string; email?: string; date?: string } | null
  }
}

type GlCommit = {
  id: string
  message: string
  author_name: string | null
  author_email: string | null
  committed_date: string
  web_url: string
}

/** First line is the subject, the rest is the body — git's own split. */
export function split(message: string): { subject: string; body: string } {
  const [first = '', ...rest] = message.split('\n')
  return { subject: first.trim(), body: rest.join('\n').trim() }
}

/**
 * The commits of one branch since a point in time.
 *
 * Returns an empty list when there is no token for that host — the normal
 * case rather than an error, same as with task links: a repository without a
 * PAT is still a repository, and a booking without commits is still a
 * booking.
 */
export async function readCommits(
  provider: RepoProvider,
  slug: string,
  branch: string,
  since: Date,
  access: ProviderAccess,
): Promise<CommitRow[]> {
  if (provider === 'GITHUB') {
    if (!access.githubToken) return []
    return github(slug, branch, since, access.githubToken)
  }
  if (!access.gitlabToken) return []
  return gitlab(slug, branch, since, access.gitlabToken, access.gitlabHost)
}

async function github(
  slug: string,
  branch: string,
  since: Date,
  token: string,
): Promise<CommitRow[]> {
  const query = new URLSearchParams({
    sha: branch,
    since: since.toISOString(),
    per_page: '100',
  })
  const res = await fetch(`https://api.github.com/repos/${slug}/commits?${query}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  // An empty repository answers 409, a missing branch 404. Neither is worth
  // an exception: the repository is configured, the branch is simply not
  // there yet.
  if (res.status === 404 || res.status === 409) return []
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  const commits = (await res.json()) as GhCommit[]

  return commits.map((entry) => {
    const { subject, body } = split(entry.commit.message)
    // Committer date, not author date: a rebased commit was written when it
    // landed, and that is the moment a booking can be matched against.
    const date = entry.commit.committer?.date ?? entry.commit.author?.date
    return {
      sha: entry.sha,
      subject,
      body,
      authorName: entry.commit.author?.name ?? '',
      authorEmail: entry.commit.author?.email ?? '',
      url: entry.html_url,
      branch,
      committedAt: date ? new Date(date) : new Date(),
    }
  })
}

async function gitlab(
  slug: string,
  branch: string,
  since: Date,
  token: string,
  host: string,
): Promise<CommitRow[]> {
  const query = new URLSearchParams({
    ref_name: branch,
    since: since.toISOString(),
    per_page: '100',
  })
  const res = await fetch(
    `${host.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(slug)}/repository/commits?${query}`,
    { headers: { 'PRIVATE-TOKEN': token } },
  )
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`GitLab HTTP ${res.status}`)
  const commits = (await res.json()) as GlCommit[]

  return commits.map((entry) => {
    const { subject, body } = split(entry.message)
    return {
      sha: entry.id,
      subject,
      body,
      authorName: entry.author_name ?? '',
      authorEmail: entry.author_email ?? '',
      url: entry.web_url,
      branch,
      committedAt: new Date(entry.committed_date),
    }
  })
}
