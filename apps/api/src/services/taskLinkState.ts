import type { TaskLinkKind } from '@prisma/client'
import type { ParsedLink } from './taskLinks.js'

/**
 * What GitHub and GitLab say about a link.
 *
 * Separate from the parsing next door because this half needs tokens and a
 * network and the other half needs neither.
 *
 * The tokens arrive as an argument rather than out of `env`, so this module
 * can be exercised against a stubbed `fetch` without a configuration behind
 * it — which matters, because the part worth getting wrong is in here: an
 * issue number that turns out to be a pull request, and the three words each
 * host uses for "merged".
 *
 * Read-only, deliberately. A to-do list that can close other people's pull
 * requests is a to-do list nobody should give a token to.
 */

/** The credentials for the two hosts, handed in by the caller. */
export type ProviderAccess = {
  githubToken?: string
  gitlabToken?: string
  /** Base URL of the GitLab instance, e.g. `https://gitlab.com`. */
  gitlabHost: string
}

/**
 * What a provider knows about a link. `kind` comes back too: a GitHub number
 * that turned out to be a pull request corrects the row, and `url` with it.
 */
export type LinkState = {
  kind?: TaskLinkKind
  url?: string
  title: string | null
  /** open | closed | merged | draft. Null for commits — they have no state. */
  state: string | null
  author: string | null
  mergedAt: Date | null
}

/**
 * Read title and state from the provider.
 *
 * Returns null when there is no token for that host, which is the normal case
 * rather than an error: a link without a title is still a link, and refusing
 * to store it would make the feature depend on a PAT nobody needs for it.
 */
export async function readLinkState(
  link: ParsedLink,
  access: ProviderAccess,
): Promise<LinkState | null> {
  if (link.provider === 'GITHUB') {
    if (!access.githubToken) return null
    return link.kind === 'COMMIT' ? githubCommit(link, access) : githubIssue(link, access)
  }
  if (!access.gitlabToken) return null
  return link.kind === 'COMMIT' ? gitlabCommit(link, access) : gitlabIssuable(link, access)
}

async function githubFetch<T>(path: string, access: ProviderAccess): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${access.githubToken!}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  return (await res.json()) as T
}

/** The first line of a commit message — the rest is the body. */
function subject(message: string): string {
  return message.split('\n')[0]!.trim()
}

async function githubCommit(link: ParsedLink, access: ProviderAccess): Promise<LinkState> {
  const data = await githubFetch<{
    sha: string
    html_url: string
    commit: { message: string; author: { name: string } }
    author: { login: string } | null
  }>(`/repos/${link.repo}/commits/${link.ref}`, access)

  return {
    url: data.html_url,
    title: subject(data.commit.message),
    state: null,
    author: data.author?.login ?? data.commit.author.name,
    mergedAt: null,
  }
}

/**
 * Issues and pull requests in one call.
 *
 * GitHub numbers both in the same sequence and serves both from the issues
 * endpoint — `pull_request` on the payload is what tells them apart. A second
 * call then gets what only the pulls endpoint has: merged and draft.
 */
async function githubIssue(link: ParsedLink, access: ProviderAccess): Promise<LinkState> {
  const issue = await githubFetch<{
    title: string
    state: string
    html_url: string
    user: { login: string } | null
    pull_request?: { merged_at: string | null }
  }>(`/repos/${link.repo}/issues/${link.ref}`, access)

  if (!issue.pull_request) {
    return {
      kind: 'ISSUE',
      url: issue.html_url,
      title: issue.title,
      state: issue.state,
      author: issue.user?.login ?? null,
      mergedAt: null,
    }
  }

  const pull = await githubFetch<{
    title: string
    state: string
    html_url: string
    draft: boolean
    merged: boolean
    merged_at: string | null
    user: { login: string } | null
  }>(`/repos/${link.repo}/pulls/${link.ref}`, access)

  return {
    kind: 'PULL_REQUEST',
    url: pull.html_url,
    title: pull.title,
    state: pull.merged ? 'merged' : pull.draft ? 'draft' : pull.state,
    author: pull.user?.login ?? null,
    mergedAt: pull.merged_at ? new Date(pull.merged_at) : null,
  }
}

async function gitlabFetch<T>(path: string, access: ProviderAccess): Promise<T> {
  const base = access.gitlabHost.replace(/\/+$/, '')
  const res = await fetch(`${base}/api/v4${path}`, {
    headers: { 'PRIVATE-TOKEN': access.gitlabToken! },
  })
  if (!res.ok) throw new Error(`GitLab HTTP ${res.status}`)
  return (await res.json()) as T
}

async function gitlabCommit(link: ParsedLink, access: ProviderAccess): Promise<LinkState> {
  const data = await gitlabFetch<{ title: string; author_name: string; web_url: string }>(
    `/projects/${encodeURIComponent(link.repo)}/repository/commits/${link.ref}`,
    access,
  )
  return {
    url: data.web_url,
    title: subject(data.title),
    state: null,
    author: data.author_name,
    mergedAt: null,
  }
}

async function gitlabIssuable(link: ParsedLink, access: ProviderAccess): Promise<LinkState> {
  const segment = link.kind === 'PULL_REQUEST' ? 'merge_requests' : 'issues'
  const data = await gitlabFetch<{
    title: string
    state: string
    web_url: string
    draft?: boolean
    merged_at?: string | null
    author: { username: string } | null
  }>(`/projects/${encodeURIComponent(link.repo)}/${segment}/${link.ref}`, access)

  // GitLab says "opened" where GitHub says "open"; the UI should not have to
  // know which host a link came from to colour a badge.
  const state = data.state === 'opened' ? (data.draft ? 'draft' : 'open') : data.state

  return {
    url: data.web_url,
    title: data.title,
    state,
    author: data.author?.username ?? null,
    mergedAt: data.merged_at ? new Date(data.merged_at) : null,
  }
}
