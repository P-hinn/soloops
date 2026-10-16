/**
 * What a booking says was done.
 *
 * A timer records that two hours happened. A commit records what happened in
 * them. This module puts the two together — which commits fall into the
 * window, and what one line of invoice-facing text out of them reads like.
 *
 * No database and no network in here: matching by timestamp and composing a
 * sentence are the parts worth having tests for, and a test that needs a
 * token to check a window boundary does not get written.
 */

export type CommitRow = {
  sha: string
  subject: string
  authorEmail: string
  committedAt: Date
  /** owner/repo — only used to tell two repositories apart in the text. */
  repoSlug: string
}

export type BookingWindow = {
  startedAt: Date
  /** A running timer has no end; those are never enriched. */
  endedAt: Date
}

export type MatchOptions = {
  /**
   * How far outside the window a commit still belongs to it. The push comes
   * after the clock stops, and the commit two minutes before it started is
   * part of the same stretch of work.
   */
  toleranceMin: number
  /**
   * Whose commits count. Empty means everyone — right for a repository
   * nobody else pushes to, wrong for one with contributors.
   */
  authors?: string[]
}

const MERGE = /^Merge (pull request|branch|remote-tracking|commit)\b/i

/**
 * Merge commits say who merged, never what was done.
 *
 * Dropped while matching rather than while composing, so that the number of
 * commits on a booking and the text made from them cannot disagree.
 */
export function isMergeCommit(subject: string): boolean {
  return MERGE.test(subject.trim())
}

/**
 * `feat(ios): rows that say what they are` -> `ios: rows that say what they
 * are`, `docs: a readme` -> `a readme`.
 *
 * The conventional-commit type is for the repository, not for the client:
 * nobody outside pays by `chore` or `refactor`. The scope survives because
 * it is the one part that says *where* the work happened.
 */
const CONVENTIONAL = /^([a-z]+)(?:\(([^)]+)\))?!?:\s*(.+)$/

export function readableSubject(subject: string): string {
  const match = CONVENTIONAL.exec(subject.trim())
  if (!match) return subject.trim()
  const [, , scope, rest] = match
  return scope ? `${scope}: ${rest}` : rest!
}

/** The last segment of `owner/repo`, which is what the repository is called. */
export function repoName(slug: string): string {
  return slug.split('/').filter(Boolean).pop() ?? slug
}

/**
 * The commits that belong to this booking.
 *
 * Sorted by time, so the text follows the day rather than the order the
 * mirror happened to read them in.
 */
export function commitsInWindow(
  commits: CommitRow[],
  window: BookingWindow,
  options: MatchOptions,
): CommitRow[] {
  const slack = Math.max(0, options.toleranceMin) * 60_000
  const from = window.startedAt.getTime() - slack
  const to = window.endedAt.getTime() + slack
  const authors = (options.authors ?? [])
    .map((mail) => mail.trim().toLowerCase())
    .filter((mail) => mail.length > 0)

  return commits
    .filter((commit) => {
      const at = commit.committedAt.getTime()
      if (at < from || at > to) return false
      if (isMergeCommit(commit.subject)) return false
      if (!authors.length) return true
      return authors.includes(commit.authorEmail.trim().toLowerCase())
    })
    .sort((a, b) => a.committedAt.getTime() - b.committedAt.getTime())
}

export type ComposeOptions = {
  /** Where the text is cut off. A line item is read, not studied. */
  maxChars?: number
}

/**
 * One line out of the commits of one booking.
 *
 * Duplicate subjects collapse, and the repository is named only when more
 * than one was touched — on a single-repo booking the name would be on every
 * part and tell nobody anything. What does not belong to the booking at all
 * was already sorted out by `commitsInWindow`.
 */
export function composeSummary(commits: CommitRow[], options: ComposeOptions = {}): string {
  const maxChars = options.maxChars ?? 400
  if (!commits.length) return ''

  const multiRepo = new Set(commits.map((commit) => commit.repoSlug)).size > 1
  const parts: string[] = []
  for (const commit of commits) {
    const subject = readableSubject(commit.subject)
    if (!subject) continue
    const part = multiRepo ? `${repoName(commit.repoSlug)}: ${subject}` : subject
    if (!parts.includes(part)) parts.push(part)
  }
  if (!parts.length) return ''

  const kept: string[] = []
  let length = 0
  for (const part of parts) {
    // The separator counts too, otherwise the cap is off by two per part.
    const grown = length + part.length + (kept.length ? 2 : 0)
    if (kept.length && grown > maxChars) break
    kept.push(part)
    length = grown
  }

  const rest = parts.length - kept.length
  const text = kept.join('; ')
  return rest > 0 ? `${text} (+${rest} weitere)` : text
}
