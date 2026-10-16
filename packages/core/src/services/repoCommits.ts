import { prisma } from '../db.js'
import { env } from '../env.js'
import { readCommits, type ProviderAccess } from './repoCommitRead.js'

/**
 * The commit mirror.
 *
 * A repository already hangs off a project, so a commit needs no mapping of
 * its own — what it needs is to still be here later. Reading commits from
 * the provider while an invoice is being drafted would put a token, a
 * network and a rate limit between a draft and its line items; so they are
 * copied in on a beat and the invoice reads the copy.
 *
 * Subject and body only. The diff stays where it belongs. Talking to the two
 * hosts is next door in repoCommitRead.ts, which needs no database.
 */

function access(): ProviderAccess {
  return {
    githubToken: env.GITHUB_TOKEN,
    gitlabToken: env.GITLAB_TOKEN,
    gitlabHost: env.GITLAB_HOST,
  }
}

/** One repository's commits of the last `COMMIT_LOOKBACK_DAYS` days. */
export async function syncRepoCommits(repoId: string): Promise<{ slug: string; commits: number }> {
  const repo = await prisma.pipelineRepo.findUniqueOrThrow({ where: { id: repoId } })
  const since = new Date(Date.now() - env.COMMIT_LOOKBACK_DAYS * 86_400_000)
  const commits = await readCommits(repo.provider, repo.slug, repo.branch, since, access())

  for (const commit of commits) {
    await prisma.repoCommit.upsert({
      where: { repoId_sha: { repoId: repo.id, sha: commit.sha } },
      create: { repoId: repo.id, ...commit },
      // A force-push can rewrite a message under the same sha only in
      // theory, but the subject is what an invoice shows — so it follows.
      update: { subject: commit.subject, body: commit.body, branch: commit.branch },
    })
  }

  return { slug: repo.slug, commits: commits.length }
}

/** Every enabled repository. One failing repo does not stop the others. */
export async function syncAllRepoCommits(): Promise<{ repos: number; commits: number }> {
  return syncRepos(await prisma.pipelineRepo.findMany({ where: { enabled: true } }))
}

/** Only the repositories of one project — what a single booking needs. */
export async function syncProjectCommits(
  projectId: string,
): Promise<{ repos: number; commits: number }> {
  return syncRepos(await prisma.pipelineRepo.findMany({ where: { projectId, enabled: true } }))
}

async function syncRepos(
  repos: { id: string; slug: string }[],
): Promise<{ repos: number; commits: number }> {
  let total = 0
  for (const repo of repos) {
    try {
      const result = await syncRepoCommits(repo.id)
      total += result.commits
    } catch (err) {
      console.warn(`[commits] ${repo.slug}: ${(err as Error).message}`)
    }
  }
  return { repos: repos.length, commits: total }
}

/** Raw commits of a project in a window, newest first. For the interface. */
export async function projectCommits(projectId: string, from: Date, to: Date) {
  return prisma.repoCommit.findMany({
    where: { repo: { projectId }, committedAt: { gte: from, lte: to } },
    orderBy: { committedAt: 'desc' },
    include: { repo: { select: { slug: true, provider: true } } },
  })
}
