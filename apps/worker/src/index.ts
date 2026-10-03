import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'

// The worker shares the Prisma client and the service layer with the API —
// one monorepo, one source of truth.
import { env } from '../../api/src/env.js'
import { initSync, prisma } from '../../api/src/db.js'
import { syncUptimeRobot } from '../../api/src/services/uptimerobot.js'
import { syncAllRepos, syncRepo } from '../../api/src/services/pipelines.js'
import { buildProjectDigest } from '../../api/src/ai/digest.js'
import { syncAccount, syncAllAccounts } from '../../api/src/services/calendarSync.js'
import { syncMailAccount, syncAllMailAccounts } from '../../api/src/services/mailSync.js'
import { scoreOpenLeads } from '../../api/src/ai/leadScore.js'

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
const log = (scope: string, msg: string) => console.log(`[${scope}] ${msg}`)

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
// AI digests
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
// Calendar sync (Google + Apple)
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
  // Sequential: two parallel runs on the same account would pull the sync
  // tokens out from under each other.
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[calendar]', err.message))

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

new Worker(
  'mail',
  async (job) => {
    const data = job.data as { accountId?: string }
    const results = data.accountId
      ? [await syncMailAccount(data.accountId)]
      : await syncAllMailAccounts()

    for (const r of results) {
      if (r.error) console.error(`[mail] ${r.account}: ${r.error}`)
      // Failed AI calls are not an abort, but no success either — without
      // this line, a run where nothing could be matched looks exactly like a
      // run where there was nothing to match.
      if (r.aiFailed) console.error(`[mail] ${r.account}: ${r.aiFailed} AI-Aufruf(e) gescheitert`)
      if (r.fetched) {
        log(
          'mail',
          `${r.account}: ${r.fetched} neu — ${r.byRule} per Regel, ${r.byAi} per AI, ${r.unassigned} offen`,
        )
      }
    }
    return results
  },
  // One account, one connection: parallel runs would overtake each other on
  // the UID cursor.
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[mail]', err.message))

// ---------------------------------------------------------------------------
// Lead scoring
// ---------------------------------------------------------------------------

new Worker(
  'leads',
  async () => {
    if (!env.ANTHROPIC_API_KEY) return { skipped: 'kein API-Key' }
    const result = await scoreOpenLeads()
    log('leads', `${result.scored} von ${result.total} Leads bewertet`)
    return result
  },
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[leads]', err.message))

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

new Worker(
  'activity',
  async () => {
    // Raw samples are a means to an end: window titles hold client and
    // private material. Anything past the retention window goes.
    const before = new Date(Date.now() - env.ACTIVITY_RETENTION_DAYS * 86_400_000)
    const { count } = await prisma.activitySample.deleteMany({ where: { at: { lt: before } } })
    if (count)
      log('activity', `${count} Stichproben älter als ${env.ACTIVITY_RETENTION_DAYS} Tage gelöscht`)
    return { deleted: count }
  },
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[activity]', err.message))

// ---------------------------------------------------------------------------
// Repeating jobs
// ---------------------------------------------------------------------------

const uptimeQueue = new Queue('uptime', { connection })
const pipelineQueue = new Queue('pipelines', { connection })
const digestQueue = new Queue('digest', { connection })
const calendarQueue = new Queue('calendar', { connection })
const mailQueue = new Queue('mail', { connection })
const leadQueue = new Queue('leads', { connection })
const activityQueue = new Queue('activity', { connection })

/**
 * Repeating jobs.
 *
 * BullMQ 6 no longer knows `repeat` in the job options; it has job
 * schedulers instead. The upside here: `upsertJobScheduler` is idempotent —
 * restarting the worker does not create a second schedule, it updates the
 * existing one under the same key.
 */
async function scheduleRepeatables() {
  await calendarQueue.upsertJobScheduler(
    'calendar-sync',
    { pattern: env.CALENDAR_SYNC_CRON },
    { name: 'sync-all', opts: { removeOnComplete: 20, removeOnFail: 20 } },
  )

  await mailQueue.upsertJobScheduler(
    'mail-sync',
    { pattern: env.MAIL_POLL_CRON },
    { name: 'sync-all', opts: { removeOnComplete: 20, removeOnFail: 20 } },
  )

  if (env.UPTIMEROBOT_API_KEY) {
    await uptimeQueue.upsertJobScheduler(
      'uptime-sync',
      { pattern: env.UPTIME_POLL_CRON },
      { name: 'sync', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    )
  }
  if (env.GITHUB_TOKEN || env.GITLAB_TOKEN) {
    await pipelineQueue.upsertJobScheduler(
      'pipeline-sync',
      { pattern: env.PIPELINE_POLL_CRON },
      { name: 'sync-all', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    )
  }
  if (env.ANTHROPIC_API_KEY) {
    // Weekdays at 7:30: a status report for every active project
    await digestQueue.upsertJobScheduler(
      'project-digests',
      { pattern: '30 7 * * 1-5' },
      {
        name: 'all-projects',
        data: { kind: 'project' },
        opts: { removeOnComplete: 10, removeOnFail: 20 },
      },
    )
  }

  if (env.ANTHROPIC_API_KEY) {
    // Leads an hour before the project digests — then the scores are in
    // place when the first look at the pipeline happens.
    await leadQueue.upsertJobScheduler(
      'lead-scores',
      { pattern: '30 6 * * 1-5' },
      { name: 'score-open', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    )
  }

  // Thin out the samples overnight — none of this is urgent.
  await activityQueue.upsertJobScheduler(
    'activity-prune',
    { pattern: '15 4 * * *' },
    { name: 'prune', opts: { removeOnComplete: 5, removeOnFail: 20 } },
  )

  // Mark overdue invoices once a day
  await digestQueue.upsertJobScheduler(
    'mark-overdue',
    { pattern: '0 6 * * *' },
    { name: 'mark-overdue', data: { kind: 'overdue' }, opts: { removeOnComplete: 5 } },
  )
}

// Its own device identity, so that digests and calendar runs end up in the
// op log without colliding with the API's sequence numbers.
const { deviceId } = await initSync('worker')
log('worker', `Sync-Geraet ${deviceId}`)

await scheduleRepeatables()
log('worker', 'bereit')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await connection.quit()
    await prisma.$disconnect()
    process.exit(0)
  })
}
