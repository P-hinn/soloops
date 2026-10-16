import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { serviceKeys } from '@soloops/core/settings.js'
import { z } from 'zod'
import { idParam, meetingInput } from '@soloops/shared'
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

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          projectId: z.string().optional(),
          from: z.string().optional(),
          take: z.coerce.number().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query
      return listMeetings(q)
    },
  )

  app.get('/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return getMeeting(id)
  })

  app.post('/', { schema: { body: meetingInput } }, async (req, reply) => {
    const data = req.body
    return reply.code(201).send(await createMeeting(data))
  })

  app.patch('/:id', { schema: { params: idParam, body: meetingInput.partial() } }, async (req) =>
    updateMeeting(req.params.id, req.body),
  )

  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    await deleteMeeting(id)
    return reply.code(204).send()
  })

  /** Create or replace the video room after the fact. */
  app.post(
    '/:id/video',
    { schema: { params: idParam, body: z.object({ url: z.string().url().optional() }) } },
    async (req) => {
      const { id } = req.params
      const body = req.body
      return setMeetingVideo(id, body.url)
    },
  )

  /** AI summary + action items from the transcript. */
  app.post('/:id/summarize', { schema: { params: idParam } }, async (req, reply) => {
    const keys = await serviceKeys()
    if (!keys.anthropic) return reply.code(503).send({ error: 'ANTHROPIC_API_KEY nicht gesetzt' })
    const { id } = req.params
    return summarizeMeeting(id)
  })

  app.post(
    '/:id/action-items',
    {
      schema: {
        params: idParam,
        body: z.object({
          title: z.string().min(1),
          dueOn: z.string().nullish(),
          assignee: z.string().nullish(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const body = req.body
      return reply.code(201).send(await addMeetingActionItem(id, body))
    },
  )
}

export default routes
