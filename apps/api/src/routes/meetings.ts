import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { meetingInput } from '@soloops/shared'
import { env } from '@soloops/core/env.js'
import { summarizeMeeting } from '@soloops/core/ai/digest.js'
import {
  addMeetingActionItem,
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  setMeetingVideo,
  updateMeeting,
} from '@soloops/core/services/meetings.js'

const idParam = z.object({ id: z.string() })

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        from: z.string().optional(),
        take: z.coerce.number().max(200).default(50),
      })
      .parse(req.query)
    return listMeetings(q)
  })

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return getMeeting(id)
  })

  app.post('/', async (req, reply) => {
    const data = meetingInput.parse(req.body)
    return reply.code(201).send(await createMeeting(data))
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return updateMeeting(id, meetingInput.partial().parse(req.body))
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await deleteMeeting(id)
    return reply.code(204).send()
  })

  /** Create or replace the video room after the fact. */
  app.post('/:id/video', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ url: z.string().url().optional() }).parse(req.body ?? {})
    return setMeetingVideo(id, body.url)
  })

  /** AI summary + action items from the transcript. */
  app.post('/:id/summarize', async (req, reply) => {
    if (!env.ANTHROPIC_API_KEY)
      return reply.code(503).send({ error: 'ANTHROPIC_API_KEY nicht gesetzt' })
    const { id } = idParam.parse(req.params)
    return summarizeMeeting(id)
  })

  app.post('/:id/action-items', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        title: z.string().min(1),
        dueOn: z.string().nullish(),
        assignee: z.string().nullish(),
      })
      .parse(req.body)
    return reply.code(201).send(await addMeetingActionItem(id, body))
  })
}

export default routes
