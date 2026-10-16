import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { timeEntryInput, timerStartInput } from '@soloops/shared'
import { commitQueue } from '@soloops/core/queue.js'
import {
  deleteTime,
  listTime,
  logTime,
  runningEntry,
  startTimer,
  stopTimer,
  timeReport,
  updateTime,
} from '@soloops/core/services/time.js'
import {
  enrichPendingTimeEntries,
  enrichTimeEntry,
  windowCommits,
} from '@soloops/core/services/timeEnrich.js'
import { syncAllRepoCommits } from '@soloops/core/services/repoCommits.js'

const idParam = z.object({ id: z.string() })

const listQuery = z.object({
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  actionItemId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  billable: z.coerce.boolean().optional(),
  unbilledOnly: z.coerce.boolean().default(false),
  take: z.coerce.number().max(500).default(200),
})

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/running', async () => runningEntry())

  app.post('/start', async (req, reply) => {
    const data = timerStartInput.parse(req.body)
    return reply.code(201).send(await startTimer(data))
  })

  app.post('/stop', async (req) => {
    const body = z.object({ id: z.string().optional() }).parse(req.body ?? {})
    const stopped = await stopTimer(body.id)

    // The commits of the last hour are usually pushed after the clock has
    // stopped, so the text is fetched with a delay rather than right now.
    // Redis being down must not cost the stop — the periodic run would pick
    // the entry up anyway.
    await commitQueue
      .add(
        'enrich-entry',
        { timeEntryId: stopped.id },
        { delay: 180_000, removeOnComplete: 50, removeOnFail: 50 },
      )
      .catch((err) => app.log.warn(`[commits] Nachtrag nicht eingeplant: ${err.message}`))

    return stopped
  })

  app.get('/', async (req) => listTime(listQuery.parse(req.query)))

  app.post('/', async (req, reply) => {
    const data = timeEntryInput.parse(req.body)
    return reply.code(201).send(await logTime(data))
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return updateTime(id, timeEntryInput.partial().parse(req.body))
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await deleteTime(id)
    return reply.code(204).send()
  })

  /**
   * Give one entry its text: the commits of its window, as one line.
   *
   * Mirrors that project's repositories first by default — right after
   * stopping the clock the worker's next beat is minutes away, and the point
   * of the button is to see the result now.
   */
  app.post('/:id/enrich', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ sync: z.boolean().default(true) }).parse(req.body ?? {})
    try {
      return await enrichTimeEntry(id, body.sync)
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
  })

  /**
   * The commits that fall into this booking's window. For a running timer
   * the window ends now, which is what the overlay shows while it counts.
   */
  app.get('/:id/commits', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    try {
      return await windowCommits(id)
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message })
    }
  })

  /** Every finished entry that still wants one. Mirror first, then match. */
  app.post('/enrich-pending', async () => {
    const mirrored = await syncAllRepoCommits()
    const result = await enrichPendingTimeEntries()
    return { ...result, repos: mirrored.repos, commits: mirrored.commits }
  })

  /** Weekly/monthly report, grouped by project. */
  app.get('/report', async (req) => {
    const q = z
      .object({ from: z.string(), to: z.string(), billableOnly: z.coerce.boolean().default(false) })
      .parse(req.query)
    return timeReport(q.from, q.to, q.billableOnly)
  })
}

export default routes
