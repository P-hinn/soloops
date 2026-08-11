import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'

// Der Worker teilt sich Prisma-Client und Service-Layer mit der API —
// ein Monorepo, eine Quelle der Wahrheit.
import { env } from '../../api/src/env.js'
import { prisma } from '../../api/src/db.js'
import { syncUptimeRobot } from '../../api/src/services/uptimerobot.js'
import { syncAllRepos, syncRepo } from '../../api/src/services/pipelines.js'
import { buildProjectDigest } from '../../api/src/ai/digest.js'
import { syncAccount, syncAllAccounts } from '../../api/src/services/calendarSync.js'
import { runTranscription } from './jobs/transcribe.js'

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
const log = (scope: string, msg: string) => console.log(`[${scope}] ${msg}`)

// ---------------------------------------------------------------------------
// Transkription (faster-whisper im Nachbarcontainer)
// ---------------------------------------------------------------------------

new Worker(
  'transcribe',
  async (job) => {
    const { meetingId } = job.data as { meetingId: string }
    log('transcribe', `Meeting ${meetingId} startet`)
    const result = await runTranscription(meetingId)
    log('transcribe', `Meeting ${meetingId} fertig (${result.chars} Zeichen)`)
    return result
  },
  { connection, concurrency: 1, lockDuration: 60 * 60 * 1000 },
)
  .on('failed', (job, err) => console.error(`[transcribe] Job ${job?.id} fehlgeschlagen:`, err.message))

// ---------------------------------------------------------------------------
// UptimeRobot
// ---------------------------------------------------------------------------

new Worker(
  'uptime',
  async () => {
    if (!env.UPTIMEROBOT_API_KEY) return { skipped: 'kein API-Key' }
    const result = await syncUptimeRobot()
    log('uptime', `${result.monitors} Monitore, ${result.incidents} Störungen`)
    return result
  },
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[uptime]', err.message))

// ---------------------------------------------------------------------------
// CI/CD
// ---------------------------------------------------------------------------

new Worker(
  'pipelines',
  async (job) => {
    if (job.name === 'sync-repo') {
      const { repoId } = job.data as { repoId: string }
      return syncRepo(repoId)
    }
    const result = await syncAllRepos()
    log('pipelines', `${result.repos} Repos, ${result.runs} Runs`)
    return result
  },
  { connection, concurrency: 2 },
).on('failed', (_job, err) => console.error('[pipelines]', err.message))

// ---------------------------------------------------------------------------
// AI-Digests
// ---------------------------------------------------------------------------

new Worker(
  'digest',
  async (job) => {
    if (job.name === 'mark-overdue') {
      const { count } = await prisma.invoice.updateMany({
        where: { status: 'SENT', dueDate: { lt: new Date() } },
        data: { status: 'OVERDUE' },
      })
      if (count) log('overdue', `${count} Rechnung(en) auf überfällig gesetzt`)
      return { overdue: count }
    }
    if (!env.ANTHROPIC_API_KEY) return { skipped: 'kein API-Key' }
    const data = job.data as { projectId?: string }
    if (data.projectId) return buildProjectDigest(data.projectId)

    const projects = await prisma.project.findMany({ where: { status: 'ACTIVE' } })
    const results: string[] = []
    for (const p of projects) {
      try {
        await buildProjectDigest(p.id)
        results.push(p.key)
      } catch (err) {
        console.error(`[digest] ${p.key}: ${(err as Error).message}`)
      }
    }
    log('digest', `Digests erneuert: ${results.join(', ') || 'keine'}`)
    return { projects: results }
  },
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[digest]', err.message))

// ---------------------------------------------------------------------------
// Kalender-Sync (Google + Apple)
// ---------------------------------------------------------------------------

new Worker(
  'calendar',
  async (job) => {
    const data = job.data as { accountId?: string }
    const results = data.accountId ? [await syncAccount(data.accountId)] : await syncAllAccounts()

    for (const r of results) {
      const parts = [
        r.pulled && `${r.pulled} rein`,
        r.pushed && `${r.pushed} raus`,
        r.deletedLocal && `${r.deletedLocal} lokal gelöscht`,
        r.deletedRemote && `${r.deletedRemote} entfernt gelöscht`,
        r.conflicts && `${r.conflicts} Konflikt(e)`,
        r.skippedSeries && `${r.skippedSeries} Serie(n) nur gelesen`,
      ].filter(Boolean)
      if (r.error) console.error(`[calendar] ${r.account}: ${r.error}`)
      else if (parts.length) log('calendar', `${r.account}: ${parts.join(', ')}`)
    }
    return results
  },
  // Sequenziell: zwei parallele Läufe auf demselben Konto würden sich
  // gegenseitig die Sync-Token unter den Füßen wegziehen.
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[calendar]', err.message))

// ---------------------------------------------------------------------------
// Wiederkehrende Jobs
// ---------------------------------------------------------------------------

const uptimeQueue = new Queue('uptime', { connection })
const pipelineQueue = new Queue('pipelines', { connection })
const digestQueue = new Queue('digest', { connection })
const calendarQueue = new Queue('calendar', { connection })

async function scheduleRepeatables() {
  await calendarQueue.add(
    'sync-all',
    {},
    { repeat: { pattern: env.CALENDAR_SYNC_CRON }, removeOnComplete: 20, removeOnFail: 20 },
  )

  if (env.UPTIMEROBOT_API_KEY) {
    await uptimeQueue.add(
      'sync',
      {},
      { repeat: { pattern: env.UPTIME_POLL_CRON }, removeOnComplete: 10, removeOnFail: 20 },
    )
  }
  if (env.GITHUB_TOKEN || env.GITLAB_TOKEN) {
    await pipelineQueue.add(
      'sync-all',
      {},
      { repeat: { pattern: env.PIPELINE_POLL_CRON }, removeOnComplete: 10, removeOnFail: 20 },
    )
  }
  if (env.ANTHROPIC_API_KEY) {
    // Werktags 7:30 Uhr: Lagebericht für alle aktiven Projekte
    await digestQueue.add(
      'all-projects',
      { kind: 'project' },
      { repeat: { pattern: '30 7 * * 1-5' }, removeOnComplete: 10, removeOnFail: 20 },
    )
  }

  // Überfällige Rechnungen einmal täglich markieren
  await digestQueue.add(
    'mark-overdue',
    { kind: 'overdue' },
    { repeat: { pattern: '0 6 * * *' }, removeOnComplete: 5 },
  )
}

await scheduleRepeatables()
log('worker', 'bereit')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await connection.quit()
    await prisma.$disconnect()
    process.exit(0)
  })
}
