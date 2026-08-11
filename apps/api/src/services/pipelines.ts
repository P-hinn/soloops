import type { RunStatus } from '@prisma/client'
import { prisma } from '../db.js'
import { env } from '../env.js'

// --- GitHub Actions ---------------------------------------------------------

type GhRun = {
  id: number
  name: string | null
  display_title: string
  head_branch: string
  head_sha: string
  status: string // queued | in_progress | completed
  conclusion: string | null // success | failure | cancelled | ...
  html_url: string
  run_started_at: string | null
  updated_at: string
  actor?: { login: string }
}

function ghStatus(run: GhRun): RunStatus {
  if (run.status === 'queued') return 'QUEUED'
  if (run.status === 'in_progress') return 'RUNNING'
  switch (run.conclusion) {
    case 'success':
      return 'SUCCESS'
    case 'failure':
    case 'timed_out':
      return 'FAILED'
    case 'cancelled':
      return 'CANCELLED'
    default:
      return 'UNKNOWN'
  }
}

// --- GitLab CI --------------------------------------------------------------

type GlPipeline = {
  id: number
  ref: string
  sha: string
  status: string // created|pending|running|success|failed|canceled|skipped
  web_url: string
  created_at: string
  updated_at: string
  user?: { username: string }
}

function glStatus(status: string): RunStatus {
  switch (status) {
    case 'created':
    case 'pending':
    case 'waiting_for_resource':
      return 'QUEUED'
    case 'running':
      return 'RUNNING'
    case 'success':
      return 'SUCCESS'
    case 'failed':
      return 'FAILED'
    case 'canceled':
      return 'CANCELLED'
    default:
      return 'UNKNOWN'
  }
}

// --- Sync -------------------------------------------------------------------

export async function syncRepo(repoId: string): Promise<{ slug: string; runs: number }> {
  const repo = await prisma.pipelineRepo.findUniqueOrThrow({ where: { id: repoId } })

  const runs =
    repo.provider === 'GITHUB' ? await fetchGithubRuns(repo.slug) : await fetchGitlabRuns(repo.slug)

  for (const run of runs) {
    await prisma.pipelineRun.upsert({
      where: { repoId_externalId: { repoId: repo.id, externalId: run.externalId } },
      create: { repoId: repo.id, ...run },
      update: { ...run },
    })
  }

  await prisma.pipelineRepo.update({ where: { id: repo.id }, data: { lastSyncedAt: new Date() } })
  return { slug: repo.slug, runs: runs.length }
}

export async function syncAllRepos(): Promise<{ repos: number; runs: number }> {
  const repos = await prisma.pipelineRepo.findMany({ where: { enabled: true } })
  let total = 0
  for (const repo of repos) {
    try {
      const result = await syncRepo(repo.id)
      total += result.runs
    } catch (err) {
      console.warn(`[pipelines] ${repo.slug}: ${(err as Error).message}`)
    }
  }
  return { repos: repos.length, runs: total }
}

type RunRow = {
  externalId: string
  name: string
  branch: string
  commitSha: string | null
  commitMessage: string | null
  status: RunStatus
  url: string | null
  actor: string | null
  startedAt: Date | null
  finishedAt: Date | null
  durationSec: number | null
}

async function fetchGithubRuns(slug: string): Promise<RunRow[]> {
  if (!env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN nicht gesetzt')
  const res = await fetch(`https://api.github.com/repos/${slug}/actions/runs?per_page=20`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`)
  const json = (await res.json()) as { workflow_runs: GhRun[] }

  return json.workflow_runs.map((run) => {
    const startedAt = run.run_started_at ? new Date(run.run_started_at) : null
    const done = run.status === 'completed'
    const finishedAt = done ? new Date(run.updated_at) : null
    return {
      externalId: String(run.id),
      name: run.name ?? 'workflow',
      branch: run.head_branch,
      commitSha: run.head_sha,
      commitMessage: run.display_title,
      status: ghStatus(run),
      url: run.html_url,
      actor: run.actor?.login ?? null,
      startedAt,
      finishedAt,
      durationSec:
        startedAt && finishedAt
          ? Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)
          : null,
    }
  })
}

async function fetchGitlabRuns(slug: string): Promise<RunRow[]> {
  if (!env.GITLAB_TOKEN) throw new Error('GITLAB_TOKEN nicht gesetzt')
  const encoded = encodeURIComponent(slug)
  const res = await fetch(`${env.GITLAB_HOST}/api/v4/projects/${encoded}/pipelines?per_page=20`, {
    headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN },
  })
  if (!res.ok) throw new Error(`GitLab HTTP ${res.status}`)
  const pipelines = (await res.json()) as GlPipeline[]

  return pipelines.map((p) => {
    const startedAt = new Date(p.created_at)
    const terminal = ['success', 'failed', 'canceled', 'skipped'].includes(p.status)
    const finishedAt = terminal ? new Date(p.updated_at) : null
    return {
      externalId: String(p.id),
      name: `pipeline #${p.id}`,
      branch: p.ref,
      commitSha: p.sha,
      commitMessage: null,
      status: glStatus(p.status),
      url: p.web_url,
      actor: p.user?.username ?? null,
      startedAt,
      finishedAt,
      durationSec: finishedAt
        ? Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000)
        : null,
    }
  })
}
