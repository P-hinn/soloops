import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import {
  idParam,
  timeEntryInput,
  timeQuery,
  timeReportQuery,
  timerStartInput,
  timerStopInput,
} from '@soloops/shared'
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

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/running', async () => runningEntry())

  app.post('/start', { schema: { body: timerStartInput } }, async (req, reply) => {
    const data = req.body
    return reply.code(201).send(await startTimer(data))
  })

  app.post('/stop', { schema: { body: timerStopInput } }, async (req) => {
    const stopped = await stopTimer(req.body.id)

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

  app.get('/', { schema: { querystring: timeQuery } }, async (req) => listTime(req.query))

  app.post('/', { schema: { body: timeEntryInput } }, async (req, reply) => {
    const data = req.body
    return reply.code(201).send(await logTime(data))
  })

  app.patch('/:id', { schema: { params: idParam, body: timeEntryInput.partial() } }, async (req) =>
    updateTime(req.params.id, req.body),
  )

  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
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
  app.post(
    '/:id/enrich',
    { schema: { params: idParam, body: z.object({ sync: z.boolean().default(true) }) } },
    async (req, reply) => {
      const { id } = req.params
      const body = req.body
      try {
        return await enrichTimeEntry(id, body.sync)
      } catch (err) {
        return reply.code(422).send({ error: (err as Error).message })
      }
    },
  )

  /**
   * The commits that fall into this booking's window. For a running timer
   * the window ends now, which is what the overlay shows while it counts.
   */
  app.get('/:id/commits', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
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
  app.get('/report', { schema: { querystring: timeReportQuery } }, async (req) => {
    const q = req.query
    return timeReport(q.from, q.to, q.billableOnly)
  })
}

export default routes
