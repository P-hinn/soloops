import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { prisma } from '@soloops/core/db.js'
import {
  changeStage,
  claimDueNotifications,
  clearFollowUp,
  completeFollowUp,
  dueFollowUps,
  followUpDays,
  leadValueCents,
  pipelineSummary,
  setFollowUp,
  stalenessDays,
  touchLead,
  weightedCents,
} from '@soloops/core/services/leads.js'
import { dropFollowUpTask } from '@soloops/core/services/leadTasks.js'
import { scoreLead } from '@soloops/core/ai/leadScore.js'
import { emitAutomationEvent } from '@soloops/core/services/automationDelivery.js'

const stage = z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'])
const source = z.enum(['REFERRAL', 'WEBSITE', 'OUTBOUND', 'NETWORK', 'EVENT', 'OTHER'])

const leadInput = z.object({
  title: z.string().min(1),
  stage: stage.optional(),
  source: source.optional(),
  contactName: z.string().nullish(),
  contactEmail: z.string().email().nullish().or(z.literal('')),
  company: z.string().nullish(),
  phone: z.string().nullish(),
  valueCents: z.coerce.number().int().min(0).nullish(),
  probability: z.coerce.number().int().min(0).max(100).optional(),
  expectedCloseOn: z.coerce.date().nullish(),
  clientId: z.string().nullish(),
  projectId: z.string().nullish(),
  notes: z.string().nullish(),
  lostReason: z.string().nullish(),
  followUpOn: z.coerce.date().nullish(),
  followUpNote: z.string().nullish(),
})

const offerInput = z.object({
  title: z.string().min(1),
  amountCents: z.coerce.number().int().min(0),
  currency: z.string().default('EUR'),
  taxRate: z.coerce.number().default(19),
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED']).optional(),
  scope: z.string().nullish(),
  number: z.string().nullish(),
  sentOn: z.coerce.date().nullish(),
  validUntil: z.coerce.date().nullish(),
  notes: z.string().nullish(),
})

/** Empty strings from forms are not values, they are "not set". */
const blankToNull = <T extends Record<string, unknown>>(data: T): T => {
  const out = { ...data }
  for (const [k, v] of Object.entries(out)) {
    if (v === '') (out as Record<string, unknown>)[k] = null
  }
  return out
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  // --- Pipeline ------------------------------------------------------------

  app.get('/pipeline', async () => pipelineSummary())

  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          stage: stage.optional(),
          open: z.coerce.boolean().optional(),
          includeArchived: z.coerce.boolean().default(false),
        }),
      },
    },
    async (req) => {
      const q = req.query

      const leads = await prisma.lead.findMany({
        where: {
          ...(q.includeArchived ? {} : { archived: false }),
          ...(q.stage ? { stage: q.stage } : {}),
          ...(q.open ? { stage: { notIn: ['WON', 'LOST'] } } : {}),
        },
        include: { offers: true, client: { select: { id: true, name: true } } },
        orderBy: [{ stage: 'asc' }, { lastActivityAt: 'desc' }],
      })

      return leads.map((lead) => ({
        ...lead,
        computedValueCents: leadValueCents(lead),
        weightedCents: weightedCents(lead),
        staleDays: stalenessDays(lead),
        followUpDays: followUpDays(lead),
      }))
    },
  )

  app.get('/:id', { schema: { params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const { id } = req.params
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        offers: { orderBy: { createdAt: 'desc' } },
        activities: { orderBy: { occurredAt: 'desc' }, take: 100 },
        mails: { orderBy: { sentAt: 'desc' }, take: 50 },
        client: { select: { id: true, name: true } },
        project: { select: { id: true, key: true, name: true } },
      },
    })
    if (!lead) return reply.code(404).send({ error: 'Lead nicht gefunden' })
    return {
      ...lead,
      computedValueCents: leadValueCents(lead),
      weightedCents: weightedCents(lead),
      staleDays: stalenessDays(lead),
      followUpDays: followUpDays(lead),
    }
  })

  app.post('/', { schema: { body: leadInput } }, async (req, reply) => {
    const data = blankToNull(req.body)
    const created = await prisma.lead.create({ data })
    await touchLead(created.id, { kind: 'NOTE', body: 'Lead angelegt', source: 'SYSTEM' })
    await emitAutomationEvent({
      event: 'LEAD_CREATED',
      projectId: created.projectId,
      path: `/leads/${created.id}`,
      data: {
        id: created.id,
        title: created.title,
        stage: created.stage,
        source: created.source,
        company: created.company,
        contactName: created.contactName,
        contactEmail: created.contactEmail,
        phone: created.phone,
        valueCents: created.valueCents,
        currency: created.currency,
        probability: created.probability,
        clientId: created.clientId,
        projectId: created.projectId,
      },
    })
    return reply.code(201).send(created)
  })

  app.patch(
    '/:id',
    { schema: { params: z.object({ id: z.string() }), body: leadInput.partial() } },
    async (req) => {
      const { id } = req.params
      const data = blankToNull(req.body)
      // Changing the stage has rules of its own (probability, history) and
      // therefore does not belong in the generic field update.
      const { stage: nextStage, followUpOn, followUpNote, ...rest } = data

      let updated = await prisma.lead.update({
        where: { id },
        data: { ...rest, ...('followUpNote' in data ? { followUpNote } : {}) },
      })

      // The follow-up is not a field like the others: it carries a ticket on
      // the board. Setting the date here used to write the column directly,
      // which left that ticket behind — so this path goes through the same two
      // functions the dedicated endpoints use.
      if ('followUpOn' in data) {
        updated = followUpOn
          ? await setFollowUp(id, followUpOn, followUpNote ?? updated.followUpNote)
          : await clearFollowUp(id)
      } else if ('followUpNote' in data && updated.followUpOn) {
        // Only the reason changed — the card on the board is named after it.
        updated = await setFollowUp(id, updated.followUpOn, followUpNote)
      }

      return nextStage && nextStage !== updated.stage ? changeStage(id, nextStage) : updated
    },
  )

  app.post(
    '/:id/stage',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ stage, note: z.string().optional() }),
      },
    },
    async (req) => {
      const { id } = req.params
      const body = req.body
      return changeStage(id, body.stage, body.note)
    },
  )

  app.delete('/:id', { schema: { params: z.object({ id: z.string() }) } }, async (req, reply) => {
    const { id } = req.params
    // Archiving takes the lead out of the pipeline, so its follow-up ticket
    // has no business staying on the board. The date on the lead survives —
    // unarchiving it later should still say when you meant to call.
    await dropFollowUpTask(id)
    await prisma.lead.update({ where: { id }, data: { archived: true } })
    return reply.code(204).send()
  })

  // --- Follow-ups ----------------------------------------------------------

  /**
   * What is due and what is coming up. `withinDays` reaches into the future;
   * overdue follow-ups are always included.
   */
  app.get(
    '/follow-ups',
    {
      schema: {
        querystring: z.object({ withinDays: z.coerce.number().min(0).max(365).default(14) }),
      },
    },
    async (req) => {
      const q = req.query
      return dueFollowUps(q.withinDays)
    },
  )

  /**
   * Hands the due reminders to the desktop app and marks them as announced.
   * A POST rather than a GET: this reads and writes.
   */
  app.post('/follow-ups/claim-notifications', async () => claimDueNotifications())

  app.post(
    '/:id/follow-up',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ on: z.coerce.date(), note: z.string().nullish() }),
      },
    },
    async (req) => {
      const { id } = req.params
      const body = req.body
      const lead = await setFollowUp(id, body.on, body.note)
      return { ...lead, days: followUpDays(lead) }
    },
  )

  app.post(
    '/:id/follow-up/done',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ note: z.string().optional() }),
      },
    },
    async (req) => {
      const { id } = req.params
      const body = req.body
      return completeFollowUp(id, body.note)
    },
  )

  app.delete(
    '/:id/follow-up',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req) => {
      const { id } = req.params
      return clearFollowUp(id)
    },
  )

  // --- History -------------------------------------------------------------

  app.post(
    '/:id/activities',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          kind: z
            .enum(['NOTE', 'CALL', 'MAIL', 'MEETING', 'OFFER', 'STAGE_CHANGE'])
            .default('NOTE'),
          body: z.string().min(1),
          occurredAt: z.coerce.date().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const body = req.body

      await touchLead(id, body)
      return reply.code(201).send({ ok: true })
    },
  )

  // --- Offers --------------------------------------------------------------

  app.post(
    '/:id/offers',
    { schema: { params: z.object({ id: z.string() }), body: offerInput } },
    async (req, reply) => {
      const { id } = req.params
      const data = req.body
      const offer = await prisma.offer.create({ data: { ...data, leadId: id } })

      await touchLead(id, {
        kind: 'OFFER',
        body: `Angebot „${offer.title}": ${(offer.amountCents / 100).toFixed(2)} ${offer.currency}`,
        occurredAt: offer.sentOn ?? undefined,
        source: 'SYSTEM',
      })

      // Sending an offer is a stage change — otherwise you would have to make
      // it by hand every single time.
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id } })
      if (offer.status === 'SENT' && (lead.stage === 'NEW' || lead.stage === 'QUALIFIED')) {
        await changeStage(id, 'PROPOSAL', 'Angebot verschickt')
      }

      return reply.code(201).send(offer)
    },
  )

  app.patch(
    '/:id/offers/:offerId',
    {
      schema: {
        params: z.object({ id: z.string(), offerId: z.string() }),
        body: offerInput.partial(),
      },
    },
    async (req) => {
      const { id, offerId } = req.params
      const data = req.body
      const offer = await prisma.offer.update({
        where: { id: offerId },
        data: {
          ...data,
          ...(data.status === 'ACCEPTED' || data.status === 'REJECTED'
            ? { decidedOn: new Date() }
            : {}),
        },
      })

      if (data.status === 'ACCEPTED')
        await changeStage(id, 'WON', `Angebot „${offer.title}" angenommen`)
      if (data.status === 'REJECTED') {
        await touchLead(id, {
          kind: 'OFFER',
          body: `Angebot „${offer.title}" abgelehnt`,
          source: 'SYSTEM',
        })
      }
      return offer
    },
  )

  app.delete(
    '/:id/offers/:offerId',
    { schema: { params: z.object({ id: z.string(), offerId: z.string() }) } },
    async (req, reply) => {
      const { offerId } = req.params
      await prisma.offer.delete({ where: { id: offerId } })
      return reply.code(204).send()
    },
  )

  // --- AI scoring ----------------------------------------------------------

  app.post(
    '/:id/score',
    { schema: { params: z.object({ id: z.string() }) } },
    async (req, reply) => {
      const { id } = req.params
      try {
        return await scoreLead(id)
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message })
      }
    },
  )
}

export default routes
