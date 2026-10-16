import { prisma } from '../db.js'
import { env } from '../env.js'
import { commitsInWindow, composeSummary, isMergeCommit, type CommitRow } from './timeNarrative.js'
import { syncProjectCommits } from './repoCommits.js'

/**
 * Gives a finished booking its text.
 *
 * The timer knows that two hours happened; the commits of those two hours
 * know what happened in them. Here the two meet: the commits in the window
 * are linked to the entry and their subjects become one line, which the
 * invoice uses when nothing was typed by hand.
 *
 * Deliberately idempotent. The commit arrives after the push, the push
 * arrives after the timer stopped, and the same entry is therefore looked at
 * more than once — every run has to end at the same result.
 */

/**
 * How long after a booking ends its text may still change. Long enough for
 * the push that follows a working day, short enough that an entry does not
 * get rewritten forever.
 */
const SETTLE_MS = 2 * 60 * 60 * 1000

function authorFilter(): string[] {
  return env.COMMIT_AUTHOR_EMAILS.split(',')
    .map((mail) => mail.trim())
    .filter(Boolean)
}

/**
 * The commits of a booking's window — matched or not yet.
 *
 * What the overlay shows while the clock runs: the window has no end there,
 * so "now" stands in for it and the list grows with the work.
 */
export async function windowCommits(id: string) {
  const entry = await find(id)
  const slack = env.TIME_COMMIT_TOLERANCE_MIN * 60_000
  const commits = await prisma.repoCommit.findMany({
    where: {
      repo: { projectId: entry.projectId },
      committedAt: {
        gte: new Date(entry.startedAt.getTime() - slack),
        lte: new Date((entry.endedAt ?? new Date()).getTime() + slack),
      },
    },
    orderBy: { committedAt: 'asc' },
    include: {
      repo: { select: { slug: true } },
      // Whether this one is already booked on this very entry.
      timeEntries: { where: { id }, select: { id: true } },
    },
  })

  const authors = authorFilter()
  return commits
    .filter((commit) => !isMergeCommit(commit.subject))
    .filter(
      (commit) =>
        !authors.length ||
        authors.some((mail) => mail.toLowerCase() === commit.authorEmail.trim().toLowerCase()),
    )
    .map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      url: commit.url,
      committedAt: commit.committedAt,
      repo: commit.repo.slug,
      /// Already booked on this entry, or still only in its window.
      linked: commit.timeEntries.length > 0,
    }))
}

/**
 * The booking, or a sentence saying it is gone.
 *
 * Not `findUniqueOrThrow`: the delayed job runs three minutes after the
 * clock stopped, and a two-second booking deleted in the meantime is the
 * normal case. What belongs in the log for that is one line, not a Prisma
 * stack trace with a highlighted query.
 */
async function find(id: string) {
  const entry = await prisma.timeEntry.findUnique({ where: { id } })
  if (!entry) throw new Error(`Zeiteintrag ${id} existiert nicht mehr`)
  return entry
}

export type EnrichResult = {
  id: string
  /** The composed line, or null when no commit fell into the window. */
  summary: string | null
  commits: number
}

/**
 * One entry.
 *
 * `sync` fetches that project's repositories first — what the overlay wants
 * right after stopping the clock, when the worker's next beat is minutes
 * away. The periodic run mirrors once for everything and passes false.
 */
export async function enrichTimeEntry(id: string, sync = true): Promise<EnrichResult> {
  const entry = await find(id)
  if (!entry.endedAt) throw new Error('Laufender Timer — erst stoppen, dann zuordnen')
  if (entry.invoiceItemId) throw new Error('Eintrag ist bereits abgerechnet')

  if (sync) await syncProjectCommits(entry.projectId)

  const slack = env.TIME_COMMIT_TOLERANCE_MIN * 60_000
  const candidates = await prisma.repoCommit.findMany({
    where: {
      repo: { projectId: entry.projectId },
      committedAt: {
        gte: new Date(entry.startedAt.getTime() - slack),
        lte: new Date(entry.endedAt.getTime() + slack),
      },
      // A commit belongs to one booking. Whichever entry got it first keeps
      // it — otherwise the same work would be on two invoice lines.
      timeEntries: { none: { id: { not: id } } },
    },
    include: { repo: { select: { slug: true } } },
  })

  const rows: CommitRow[] = candidates.map((commit) => ({
    sha: commit.sha,
    subject: commit.subject,
    authorEmail: commit.authorEmail,
    committedAt: commit.committedAt,
    repoSlug: commit.repo.slug,
  }))

  const matched = commitsInWindow(
    rows,
    { startedAt: entry.startedAt, endedAt: entry.endedAt },
    { toleranceMin: env.TIME_COMMIT_TOLERANCE_MIN, authors: authorFilter() },
  )
  const summary = composeSummary(matched)
  const ids = candidates
    .filter((commit) => matched.some((row) => row.sha === commit.sha))
    .map((commit) => ({ id: commit.id }))

  await prisma.timeEntry.update({
    where: { id },
    data: {
      autoSummary: summary || null,
      enrichedAt: new Date(),
      // `set`, not `connect`: a commit that has moved out of the window on a
      // second run has to leave the entry again.
      commits: { set: ids },
    },
  })

  return { id, summary: summary || null, commits: ids.length }
}

/**
 * Every finished booking that still wants a text.
 *
 * Takes what is already mirrored — the caller mirrors once beforehand, so
 * that ten entries of one project do not mean ten calls to the provider.
 */
export async function enrichPendingTimeEntries(): Promise<{ looked: number; enriched: number }> {
  const since = new Date(Date.now() - env.COMMIT_LOOKBACK_DAYS * 86_400_000)
  const candidates = await prisma.timeEntry.findMany({
    where: {
      endedAt: { not: null, gte: since },
      // Billed time is settled. Rewriting the text behind an invoice line
      // would make the invoice and its source disagree.
      invoiceItemId: null,
      // Only projects that have a repository at all.
      project: { repos: { some: { enabled: true } } },
    },
    select: { id: true, endedAt: true, enrichedAt: true },
    orderBy: { startedAt: 'desc' },
  })

  const due = candidates.filter(
    (entry) =>
      !entry.enrichedAt ||
      // Still inside the settling window: a late push may still arrive.
      entry.enrichedAt.getTime() < (entry.endedAt?.getTime() ?? 0) + SETTLE_MS,
  )

  let enriched = 0
  for (const entry of due) {
    try {
      const result = await enrichTimeEntry(entry.id, false)
      if (result.commits) enriched++
    } catch (err) {
      console.warn(`[commits] Zeiteintrag ${entry.id}: ${(err as Error).message}`)
    }
  }
  return { looked: due.length, enriched }
}
