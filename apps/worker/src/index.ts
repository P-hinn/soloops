import { Queue, Worker } from 'bullmq'
import IORedis from 'ioredis'

// The worker and the API are two processes over one set of rules, and the
// rules live in @soloops/core — including the Prisma client, so that the
// sync log sees the worker's writes too.
import { env } from '@soloops/core/env.js'
import { cronSettings, serviceKeys } from '@soloops/core/settings.js'
import { changedSchedules, type Schedules } from '@soloops/core/services/schedules.js'
import { initSync, prisma } from '@soloops/core/db.js'
import { syncUptimeRobot } from '@soloops/core/services/uptimerobot.js'
import { syncAllRepos, syncRepo } from '@soloops/core/services/pipelines.js'
import { syncAllRepoCommits, syncRepoCommits } from '@soloops/core/services/repoCommits.js'
import { enrichPendingTimeEntries, enrichTimeEntry } from '@soloops/core/services/timeEnrich.js'
import { buildProjectDigest } from '@soloops/core/ai/digest.js'
import { syncAccount, syncAllAccounts } from '@soloops/core/services/calendarSync.js'
import { syncMailAccount, syncAllMailAccounts } from '@soloops/core/services/mailSync.js'
import { scoreOpenLeads } from '@soloops/core/ai/leadScore.js'
import { syncAutomations } from '@soloops/core/services/automations.js'
import { deliver, type DeliveryJob } from '@soloops/core/services/automationDelivery.js'

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
// Commits -> bookings
// ---------------------------------------------------------------------------

new Worker(
  'commits',
  async (job) => {
    // One booking, usually three minutes after its timer stopped.
    if (job.name === 'enrich-entry') {
      const { timeEntryId } = job.data as { timeEntryId: string }
      const result = await enrichTimeEntry(timeEntryId)
      if (result.commits) log('commits', `${result.commits} Commit(s): ${result.summary}`)
      return result
    }
    if (job.name === 'sync-repo') {
      const { repoId } = job.data as { repoId: string }
      return syncRepoCommits(repoId)
    }

    // The beat: mirror everything, then give every finished booking that is
    // still missing one its text.
    const mirrored = await syncAllRepoCommits()
    const enriched = await enrichPendingTimeEntries()
    if (mirrored.commits || enriched.enriched) {
      log(
        'commits',
        `${mirrored.commits} Commit(s) aus ${mirrored.repos} Repo(s), ${enriched.enriched} von ${enriched.looked} Zeiteintraegen zugeordnet`,
      )
    }
    return { ...mirrored, ...enriched }
  },
  // One at a time: the provider has a rate limit, and nothing in here is
  // urgent enough to spend it twice over.
  { connection, concurrency: 1 },
).on('failed', (_job, err) => console.error('[commits]', err.message))

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
// Automations (n8n)
// ---------------------------------------------------------------------------

// Declared up here, unlike the other queues at the bottom: this worker
// enqueues onto its own queue to schedule a retry, and a reference that only
// happens to resolve by the time a job runs is a trap for the next reader.
const automationQueue = new Queue('automations', { connection })

new Worker(
  'automations',
  async (job) => {
    if (job.name === 'dispatch') {
      const data = job.data as DeliveryJob
      const outcome = await deliver(data)

      // The retry is a new job rather than a thrown error on this one. BullMQ
      // would retry too, but its attempt counter is invisible to the delivery
      // log — and that log is the whole point of recording attempts.
      if (outcome.retryInMs !== null) {
        await automationQueue.add(
          'dispatch',
          { ...data, attempt: data.attempt + 1 },
          { delay: outcome.retryInMs, removeOnComplete: 200, removeOnFail: 200 },
        )
        log(
          'automations',
          `Zustellung ${data.payload.event} fehlgeschlagen (${outcome.error}), neuer Versuch in ${Math.round(outcome.retryInMs / 1000)}s`,
        )
      } else if (!outcome.ok) {
        console.error(`[automations] ${data.payload.event} endgültig gescheitert: ${outcome.error}`)
      }
      return outcome
    }

    const result = await syncAutomations()
    if (result.skipped) return result
    if (result.flows || result.missing) {
      log(
        'automations',
        `${result.flows} Flows, ${result.runs} Läufe${result.missing ? `, ${result.missing} in n8n gelöscht` : ''}`,
      )
    }
    return result
  },
  // Deliveries and the mirror sync share this worker, so a handful at a time:
  // enough that one slow webhook does not hold up the next event, few enough
  // that a burst of events cannot bury n8n.
  { connection, concurrency: 4 },
).on('failed', (_job, err) => console.error('[automations]', err.message))

// ---------------------------------------------------------------------------
// Repeating jobs
// ---------------------------------------------------------------------------

const uptimeQueue = new Queue('uptime', { connection })
const pipelineQueue = new Queue('pipelines', { connection })
const commitQueue = new Queue('commits', { connection })
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
async function scheduleRepeatables(): Promise<Schedules> {
  // Read per run, not at startup: the intervals can be changed in the
  // interface, and a cron that only takes effect after a restart is a
  // setting that lies.
  const crons = await cronSettings()
  const keys = await serviceKeys()
  const planned: Schedules = {}
  const note = (key: string, pattern: string) => {
    planned[key] = pattern
    return pattern
  }
  await calendarQueue.upsertJobScheduler(
    'calendar-sync',
    { pattern: note('calendar-sync', crons.calendar) },
    { name: 'sync-all', opts: { removeOnComplete: 20, removeOnFail: 20 } },
  )

  await mailQueue.upsertJobScheduler(
    'mail-sync',
    { pattern: note('mail-sync', crons.mail) },
    { name: 'sync-all', opts: { removeOnComplete: 20, removeOnFail: 20 } },
  )

  if (keys.uptimerobot) {
    await uptimeQueue.upsertJobScheduler(
      'uptime-sync',
      { pattern: note('uptime-sync', crons.uptime) },
      { name: 'sync', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    )
  }
  if (keys.github || keys.gitlab) {
    await pipelineQueue.upsertJobScheduler(
      'pipeline-sync',
      { pattern: note('pipeline-sync', crons.pipelines) },
      { name: 'sync-all', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    )
    // Slower than the pipelines: a commit that lands in the mirror ten
    // minutes late changes no booking, a spent rate limit changes all of
    // them.
    await commitQueue.upsertJobScheduler(
      'commit-sync',
      { pattern: note('commit-sync', crons.commits) },
      { name: 'sync', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    )
  }
  if (keys.anthropic) {
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

  if (keys.anthropic) {
    // Leads an hour before the project digests — then the scores are in
    // place when the first look at the pipeline happens.
    await leadQueue.upsertJobScheduler(
      'lead-scores',
      { pattern: '30 6 * * 1-5' },
      { name: 'score-open', opts: { removeOnComplete: 10, removeOnFail: 20 } },
    )
  }

  // The n8n mirror. Runs unconditionally: whether there is an API key is
  // decided inside the sync, and a key pasted into the interface should take
  // effect without a worker restart.
  await automationQueue.upsertJobScheduler(
    'automation-sync',
    { pattern: note('automation-sync', crons.automations) },
    { name: 'sync', opts: { removeOnComplete: 10, removeOnFail: 20 } },
  )

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

  return planned
}

/**
 * Keep the schedule in step with the settings.
 *
 * Checked once a minute. Only a changed pattern causes a rewrite —
 * `upsertJobScheduler` is idempotent, but a write per schedule per minute
 * would be noise in Redis for nothing.
 */
function watchSchedules(planned: Schedules) {
  setInterval(() => {
    void (async () => {
      try {
        const next = await cronSettings()
        const wanted: Schedules = {
          'calendar-sync': next.calendar,
          'mail-sync': next.mail,
          'uptime-sync': next.uptime,
          'pipeline-sync': next.pipelines,
          'commit-sync': next.commits,
          'automation-sync': next.automations,
        }
        // Only schedules that are actually planned: whether uptime runs at
        // all is decided by whether there is a key for it.
        const changed = changedSchedules(planned, wanted).filter((key) => key in planned)
        if (changed.length === 0) return

        log('worker', `Zeitplaene geaendert: ${changed.join(', ')} — neu geplant`)
        planned = await scheduleRepeatables()
      } catch (err) {
        log('worker', `Zeitplaene nicht pruefbar: ${(err as Error).message}`)
      }
    })()
  }, 60_000)
}

// Its own device identity, so that digests and calendar runs end up in the
// op log without colliding with the API's sequence numbers.
const { deviceId } = await initSync('worker')
log('worker', `Sync-Geraet ${deviceId}`)

watchSchedules(await scheduleRepeatables())
log('worker', 'bereit')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await connection.quit()
    await prisma.$disconnect()
    process.exit(0)
  })
}
