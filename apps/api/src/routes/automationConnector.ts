import type { AutomationEvent } from '@prisma/client'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { changeStage, leadValueCents, touchLead, weightedCents } from '../services/leads.js'
import { emitAutomationEvent, newSecret, sealSecret } from '../services/automationDelivery.js'
import { eventFromWire } from '../services/automationEvents.js'

/**
 * What an n8n workflow may do to soloops.
 *
 * A deliberately narrow surface, and the reason automation tokens do not pass
 * the ordinary gate. The rest of the API grew for an interface a person is
 * looking at; this is a contract a workflow graph is typed against, and those
 * two want opposite things. Here nothing is renamed, nothing is removed, and
 * nothing more is exposed than a connector needs — a workflow somebody built
 * eight months ago should still run.
 *
 * Scope enforcement lives in authenticateConnector: anything that is not a
 * GET needs the write scope.
 */

const idParam = z.object({ id: z.string() })

const stage = z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'])
const source = z.enum(['REFERRAL', 'WEBSITE', 'OUTBOUND', 'NETWORK', 'EVENT', 'OTHER'])
const activityKind = z.enum(['NOTE', 'CALL', 'MAIL', 'MEETING', 'OFFER', 'STAGE_CHANGE'])

type LeadRow = {
  id: string
  title: string
  stage: string
  source: string
  contactName: string | null
  contactEmail: string | null
  company: string | null
  phone: string | null
  valueCents: number | null
  currency: string
  probability: number
  expectedCloseOn: Date | null
  clientId: string | null
  projectId: string | null
  notes: string | null
  lastActivityAt: Date
  createdAt: Date
  offers?: { status: string; amountCents: number; sentOn: Date | null }[]
}

/**
 * The lead shape a workflow sees: flat, and with the arithmetic already
 * resolved. `valueCents` here is the effective value — an offer that has gone
 * out beats the estimate, see leadMath.ts — because an expression in a
 * workflow graph cannot do that reasoning itself.
 */
function leadOut(lead: LeadRow) {
  return {
    id: lead.id,
    title: lead.title,
    stage: lead.stage,
    source: lead.source,
    contactName: lead.contactName,
    contactEmail: lead.contactEmail,
    company: lead.company,
    phone: lead.phone,
    valueCents: leadValueCents(lead),
    currency: lead.currency,
    probability: lead.probability,
    weightedCents: weightedCents(lead),
    expectedCloseOn: lead.expectedCloseOn,
    clientId: lead.clientId,
    projectId: lead.projectId,
    notes: lead.notes,
    lastActivityAt: lead.lastActivityAt,
    createdAt: lead.createdAt,
  }
}

const offerSelect = { select: { status: true, amountCents: true, sentOn: true } } as const

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticateConnector)

  /** Lets the credential in n8n verify itself without changing anything. */
  app.get('/ping', async (req) => ({
    ok: true,
    principal: req.principal?.type ?? 'unknown',
    scopes: req.principal?.type === 'automation' ? req.principal.scopes : ['read', 'write'],
  }))

  // --- Trigger registration ------------------------------------------------
  //
  // The Soloops Trigger node calls these three itself, the way n8n's own
  // integrations register a webhook with the service they watch. That is what
  // makes the connector work without anyone copying a URL by hand: switching
  // the workflow on in n8n is what tells soloops where to post.

  app.post('/triggers', async (req, reply) => {
    const body = z
      .object({
        /** The wire name, e.g. "lead.won". Unknown names are refused. */
        event: z.string(),
        webhookUrl: z.string().url(),
        projectId: z.string().nullish(),
        /** n8n's workflow id, so the trigger shows up next to its flow. */
        workflowId: z.string().nullish(),
      })
      .parse(req.body)

    const event = eventFromWire(body.event)
    if (!event) return reply.code(422).send({ error: `Unbekanntes Event: ${body.event}` })

    const flow = body.workflowId
      ? await prisma.automationFlow.findUnique({ where: { n8nId: body.workflowId } })
      : null

    // A secret per trigger, so the receiving workflow can tell a real call
    // from a replayed one. Generated here because registration is the only
    // moment soloops can hand it over.
    const secret = newSecret()
    const existing = await findTrigger(body.webhookUrl, event)

    // Not an upsert: the natural key is (webhookUrl, event), and a URL is too
    // long to put under a unique index reliably. Lookup then branch is the
    // same two queries without the index.
    const trigger = existing
      ? await prisma.automationTrigger.update({
          where: { id: existing.id },
          data: {
            projectId: body.projectId ?? null,
            flowId: flow?.id ?? null,
            secretEnc: sealSecret(secret),
            // Switching a workflow back on in n8n is the clearest "this
            // should work again" there is — it revives a trigger that had
            // switched itself off after too many failures.
            enabled: true,
            failStreak: 0,
            lastError: null,
          },
        })
      : await prisma.automationTrigger.create({
          data: {
            event,
            webhookUrl: body.webhookUrl,
            projectId: body.projectId ?? null,
            flowId: flow?.id ?? null,
            secretEnc: sealSecret(secret),
          },
        })

    return reply.code(201).send({ id: trigger.id, event: body.event, secret })
  })

  /** `checkExists` on the node side: does soloops already post here. */
  app.get('/triggers/by-url', async (req) => {
    const q = z.object({ webhookUrl: z.string().url(), event: z.string() }).parse(req.query)
    const event = eventFromWire(q.event)
    if (!event) return { exists: false }
    const trigger = await findTrigger(q.webhookUrl, event)
    return { exists: !!trigger, id: trigger?.id ?? null, enabled: trigger?.enabled ?? false }
  })

  /** `delete` on the node side: switching the workflow off stops the posting. */
  app.delete('/triggers/by-url', async (req) => {
    const q = z.object({ webhookUrl: z.string().url(), event: z.string() }).parse(req.query)
    const event = eventFromWire(q.event)
    if (!event) return { deleted: 0 }
    const { count } = await prisma.automationTrigger.deleteMany({
      where: { webhookUrl: q.webhookUrl, event },
    })
    return { deleted: count }
  })

  function findTrigger(webhookUrl: string, event: AutomationEvent) {
    return prisma.automationTrigger.findFirst({
      where: { webhookUrl, event },
      select: { id: true, enabled: true },
    })
  }

  // --- Leads ---------------------------------------------------------------

  app.get('/leads', async (req) => {
    const q = z
      .object({
        stage: stage.optional(),
        openOnly: z.coerce.boolean().optional(),
        projectId: z.string().optional(),
        limit: z.coerce.number().max(200).default(50),
      })
      .parse(req.query)

    const leads = await prisma.lead.findMany({
      where: {
        archived: false,
        // openOnly and an explicit stage are mutually exclusive; the explicit
        // one is the more specific ask, so it wins.
        stage: q.stage ?? (q.openOnly ? { notIn: ['WON', 'LOST'] } : undefined),
        projectId: q.projectId,
      },
      orderBy: { lastActivityAt: 'desc' },
      take: q.limit,
      include: { offers: offerSelect },
    })
    return leads.map(leadOut)
  })

  app.get('/leads/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { id },
      include: { offers: offerSelect },
    })
    return leadOut(lead)
  })

  app.post('/leads', async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        stage: stage.optional(),
        source: source.optional(),
        contactName: z.string().nullish(),
        contactEmail: z.string().email().nullish(),
        company: z.string().nullish(),
        phone: z.string().nullish(),
        valueCents: z.coerce.number().int().min(0).nullish(),
        probability: z.coerce.number().int().min(0).max(100).optional(),
        expectedCloseOn: z.coerce.date().nullish(),
        clientId: z.string().nullish(),
        projectId: z.string().nullish(),
        notes: z.string().nullish(),
      })
      .parse(req.body)

    const lead = await prisma.lead.create({ data: body })
    const out = leadOut({ ...lead, offers: [] })
    await emitAutomationEvent({
      event: 'LEAD_CREATED',
      projectId: lead.projectId,
      path: `/leads/${lead.id}`,
      data: out,
    })
    return out
  })

  app.patch('/leads/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        title: z.string().min(1).optional(),
        contactName: z.string().nullish(),
        contactEmail: z.string().email().nullish(),
        company: z.string().nullish(),
        phone: z.string().nullish(),
        valueCents: z.coerce.number().int().min(0).nullish(),
        probability: z.coerce.number().int().min(0).max(100).optional(),
        expectedCloseOn: z.coerce.date().nullish(),
        clientId: z.string().nullish(),
        projectId: z.string().nullish(),
        notes: z.string().nullish(),
      })
      .parse(req.body)

    const lead = await prisma.lead.update({
      where: { id },
      data: body,
      include: { offers: offerSelect },
    })
    return leadOut(lead)
  })

  /**
   * Moving a lead's stage goes through the shared service rather than a plain
   * update: that is what writes the history entry and keeps the probability
   * honest. It also fires the stage events, so one call here can set off the
   * next automation.
   */
  app.post('/leads/:id/stage', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ stage, note: z.string().optional() }).parse(req.body)
    const lead = await changeStage(id, body.stage, body.note)
    return leadOut({ ...lead, offers: [] })
  })

  app.post('/leads/:id/activity', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({
        kind: activityKind.default('NOTE'),
        body: z.string().min(1),
        occurredAt: z.coerce.date().optional(),
      })
      .parse(req.body)
    await touchLead(id, { ...body, source: 'SYSTEM' })
    return { ok: true }
  })

  // --- Projects ------------------------------------------------------------

  app.get('/projects', async (req) => {
    const q = z
      .object({
        status: z.enum(['ACTIVE', 'PAUSED', 'DONE', 'ARCHIVED']).optional(),
        limit: z.coerce.number().max(200).default(50),
      })
      .parse(req.query)
    return prisma.project.findMany({
      where: { status: q.status },
      orderBy: { name: 'asc' },
      take: q.limit,
      select: {
        id: true,
        key: true,
        name: true,
        status: true,
        clientId: true,
        hourlyRateCents: true,
        dueOn: true,
      },
    })
  })

  app.post('/projects', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        key: z.string().min(1).max(32),
        description: z.string().nullish(),
        clientId: z.string().nullish(),
        hourlyRateCents: z.coerce.number().int().min(0).nullish(),
        dueOn: z.coerce.date().nullish(),
      })
      .parse(req.body)

    const project = await prisma.project.create({ data: body })
    await emitAutomationEvent({
      event: 'PROJECT_CREATED',
      projectId: project.id,
      path: `/projects/${project.id}`,
      data: { id: project.id, key: project.key, name: project.name, clientId: project.clientId },
    })
    return project
  })

  // --- Tasks ---------------------------------------------------------------

  app.get('/tasks', async (req) => {
    const q = z
      .object({
        done: z.coerce.boolean().optional(),
        projectId: z.string().optional(),
        limit: z.coerce.number().max(200).default(50),
      })
      .parse(req.query)
    return prisma.actionItem.findMany({
      where: { done: q.done, projectId: q.projectId },
      orderBy: [{ done: 'asc' }, { dueOn: 'asc' }],
      take: q.limit,
    })
  })

  app.post('/tasks', async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        dueOn: z.coerce.date().nullish(),
        assignee: z.string().nullish(),
        projectId: z.string().nullish(),
        meetingId: z.string().nullish(),
      })
      .parse(req.body)
    // `source` marks where it came from, so a flood from a misfiring workflow
    // can be cleared out without taking hand-written tasks with it.
    return prisma.actionItem.create({ data: { ...body, source: 'MCP' } })
  })

  app.post('/tasks/:id/complete', async (req) => {
    const { id } = idParam.parse(req.params)
    const task = await prisma.actionItem.update({ where: { id }, data: { done: true } })
    await emitAutomationEvent({
      event: 'TASK_COMPLETED',
      projectId: task.projectId,
      path: task.projectId ? `/projects/${task.projectId}` : null,
      data: { id: task.id, title: task.title, projectId: task.projectId },
    })
    return task
  })

  // --- Time ----------------------------------------------------------------

  app.post('/time', async (req) => {
    const body = z
      .object({
        projectId: z.string(),
        /** Minutes, because that is how a workflow thinks about a duration. */
        minutes: z.coerce
          .number()
          .int()
          .min(1)
          .max(24 * 60),
        description: z.string().default(''),
        startedAt: z.coerce.date().optional(),
        billable: z.boolean().default(true),
        tags: z.array(z.string()).default([]),
      })
      .parse(req.body)

    // The column is seconds; the API takes minutes. Converting at the edge
    // keeps every report downstream on one unit.
    const durationSec = body.minutes * 60
    const startedAt = body.startedAt ?? new Date(Date.now() - durationSec * 1000)

    return prisma.timeEntry.create({
      data: {
        projectId: body.projectId,
        startedAt,
        endedAt: new Date(startedAt.getTime() + durationSec * 1000),
        durationSec,
        description: body.description,
        billable: body.billable,
        tags: body.tags,
        source: 'MCP',
      },
    })
  })

  // --- Notes ---------------------------------------------------------------

  app.post('/notes', async (req) => {
    const body = z
      .object({
        title: z.string().min(1),
        body: z.string().default(''),
        tags: z.array(z.string()).default([]),
        projectId: z.string().nullish(),
        clientId: z.string().nullish(),
      })
      .parse(req.body)

    const note = await prisma.note.create({ data: body })
    await emitAutomationEvent({
      event: 'NOTE_CREATED',
      projectId: note.projectId,
      path: '/notes',
      data: { id: note.id, title: note.title, tags: note.tags, projectId: note.projectId },
    })
    return note
  })
}

export default routes
