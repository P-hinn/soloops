import type { AutomationEvent } from '@prisma/client'
import { idParam } from '@soloops/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { prisma } from '@soloops/core/db.js'
import {
  changeStage,
  leadValueCents,
  touchLead,
  weightedCents,
} from '@soloops/core/services/leads.js'
import {
  emitAutomationEvent,
  newSecret,
  sealSecret,
} from '@soloops/core/services/automationDelivery.js'
import { eventFromWire } from '@soloops/core/services/automationEvents.js'
import { completeTask, createTask } from '@soloops/core/services/taskWrite.js'
import { resolveSignedPath, signedFileName } from '@soloops/core/services/contracts.js'
import { logTime } from '@soloops/core/services/time.js'

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

/**
 * What a workflow gets to see of a customer.
 *
 * The invoicing details are in there because a contract names the payment
 * term; `lexofficeContactId` is not, because it belongs to this machine's
 * accounting link and means nothing anywhere else.
 */
const clientOut = {
  id: true,
  name: true,
  company: true,
  email: true,
  phone: true,
  street: true,
  zip: true,
  city: true,
  country: true,
  vatId: true,
  currency: true,
  hourlyRateCents: true,
  paymentTermDays: true,
  archived: true,
} as const

const routes: FastifyPluginAsyncZod = async (app) => {
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

  app.post(
    '/triggers',
    {
      schema: {
        body: z.object({
          /** The wire name, e.g. "lead.won". Unknown names are refused. */
          event: z.string(),
          webhookUrl: z.string().url(),
          projectId: z.string().nullish(),
          /** n8n's workflow id, so the trigger shows up next to its flow. */
          workflowId: z.string().nullish(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body

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
    },
  )

  /** `checkExists` on the node side: does soloops already post here. */
  app.get(
    '/triggers/by-url',
    { schema: { querystring: z.object({ webhookUrl: z.string().url(), event: z.string() }) } },
    async (req) => {
      const q = req.query
      const event = eventFromWire(q.event)
      if (!event) return { exists: false }
      const trigger = await findTrigger(q.webhookUrl, event)
      return { exists: !!trigger, id: trigger?.id ?? null, enabled: trigger?.enabled ?? false }
    },
  )

  /** `delete` on the node side: switching the workflow off stops the posting. */
  app.delete(
    '/triggers/by-url',
    { schema: { querystring: z.object({ webhookUrl: z.string().url(), event: z.string() }) } },
    async (req) => {
      const q = req.query
      const event = eventFromWire(q.event)
      if (!event) return { deleted: 0 }
      const { count } = await prisma.automationTrigger.deleteMany({
        where: { webhookUrl: q.webhookUrl, event },
      })
      return { deleted: count }
    },
  )

  function findTrigger(webhookUrl: string, event: AutomationEvent) {
    return prisma.automationTrigger.findFirst({
      where: { webhookUrl, event },
      select: { id: true, enabled: true },
    })
  }

  // --- Leads ---------------------------------------------------------------

  app.get(
    '/leads',
    {
      schema: {
        querystring: z.object({
          stage: stage.optional(),
          openOnly: z.coerce.boolean().optional(),
          projectId: z.string().optional(),
          limit: z.coerce.number().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query

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
    },
  )

  app.get('/leads/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { id },
      include: { offers: offerSelect },
    })
    return leadOut(lead)
  })

  app.post(
    '/leads',
    {
      schema: {
        body: z.object({
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
        }),
      },
    },
    async (req) => {
      const body = req.body

      const lead = await prisma.lead.create({ data: body })
      const out = leadOut({ ...lead, offers: [] })
      await emitAutomationEvent({
        event: 'LEAD_CREATED',
        projectId: lead.projectId,
        path: `/leads/${lead.id}`,
        data: out,
      })
      return out
    },
  )

  app.patch(
    '/leads/:id',
    {
      schema: {
        params: idParam,
        body: z.object({
          title: z.string().min(1).optional(),
          contactName: z.string().nullish(),
          contactEmail: z.string().email().nullish(),
          company: z.string().nullish(),
          phone: z.string().nullish(),
          valueCents: z.coerce.number().int().min(0).nullish(),
          probability: z.coerce.number().int().min(0).max(100).optional(),
          expectedCloseOn: z.coerce.date().nullish(),
          // The n8n node has always offered this on an update and the regular
          // PATCH /api/leads/:id has always taken it — only the connector
          // dropped it on the floor, so picking a source in a workflow did
          // nothing and said nothing about it. Found by the node's contract
          // test, which is the whole reason that test exists.
          source: source.optional(),
          clientId: z.string().nullish(),
          projectId: z.string().nullish(),
          notes: z.string().nullish(),
        }),
      },
    },
    async (req) => {
      const { id } = req.params
      const body = req.body

      const lead = await prisma.lead.update({
        where: { id },
        data: body,
        include: { offers: offerSelect },
      })
      return leadOut(lead)
    },
  )

  /**
   * Moving a lead's stage goes through the shared service rather than a plain
   * update: that is what writes the history entry and keeps the probability
   * honest. It also fires the stage events, so one call here can set off the
   * next automation.
   */
  app.post(
    '/leads/:id/stage',
    { schema: { params: idParam, body: z.object({ stage, note: z.string().optional() }) } },
    async (req) => {
      const { id } = req.params
      const body = req.body
      const lead = await changeStage(id, body.stage, body.note)
      return leadOut({ ...lead, offers: [] })
    },
  )

  app.post(
    '/leads/:id/activity',
    {
      schema: {
        params: idParam,
        body: z.object({
          kind: activityKind.default('NOTE'),
          body: z.string().min(1),
          occurredAt: z.coerce.date().optional(),
        }),
      },
    },
    async (req) => {
      const { id } = req.params
      const body = req.body
      await touchLead(id, { ...body, source: 'SYSTEM' })
      return { ok: true }
    },
  )

  // --- Clients -------------------------------------------------------------
  //
  // Read-only. A workflow that fills a contract needs the address and the
  // person it is addressed to; creating or changing a customer from a graph
  // is a different kind of decision and stays in the interface.

  app.get(
    '/clients',
    {
      schema: {
        querystring: z.object({
          q: z.string().optional(),
          archived: z.coerce.boolean().default(false),
          limit: z.coerce.number().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query

      return prisma.client.findMany({
        where: {
          archived: q.archived,
          ...(q.q
            ? {
                OR: [
                  { name: { contains: q.q, mode: 'insensitive' } },
                  { company: { contains: q.q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: { name: 'asc' },
        take: q.limit,
        select: clientOut,
      })
    },
  )

  app.get('/clients/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return prisma.client.findUniqueOrThrow({ where: { id }, select: clientOut })
  })

  // --- Projects ------------------------------------------------------------

  app.get(
    '/projects',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['ACTIVE', 'PAUSED', 'DONE', 'ARCHIVED']).optional(),
          limit: z.coerce.number().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query
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
    },
  )

  app.post(
    '/projects',
    {
      schema: {
        body: z.object({
          name: z.string().min(1),
          key: z.string().min(1).max(32),
          description: z.string().nullish(),
          clientId: z.string().nullish(),
          hourlyRateCents: z.coerce.number().int().min(0).nullish(),
          dueOn: z.coerce.date().nullish(),
        }),
      },
    },
    async (req) => {
      const body = req.body

      const project = await prisma.project.create({ data: body })
      await emitAutomationEvent({
        event: 'PROJECT_CREATED',
        projectId: project.id,
        path: `/projects/${project.id}`,
        data: { id: project.id, key: project.key, name: project.name, clientId: project.clientId },
      })
      return project
    },
  )

  // --- Tasks ---------------------------------------------------------------

  app.get(
    '/tasks',
    {
      schema: {
        querystring: z.object({
          done: z.coerce.boolean().optional(),
          projectId: z.string().optional(),
          clientId: z.string().optional(),
          /** Substring on the title — how a workflow finds back its own task. */
          q: z.string().optional(),
          limit: z.coerce.number().max(200).default(50),
        }),
      },
    },
    async (req) => {
      const q = req.query
      return prisma.actionItem.findMany({
        where: {
          done: q.done,
          projectId: q.projectId,
          clientId: q.clientId,
          ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
        },
        orderBy: [{ done: 'asc' }, { dueOn: 'asc' }],
        take: q.limit,
      })
    },
  )

  app.post(
    '/tasks',
    {
      schema: {
        body: z.object({
          title: z.string().min(1),
          dueOn: z.coerce.date().nullish(),
          assignee: z.string().nullish(),
          projectId: z.string().nullish(),
          clientId: z.string().nullish(),
          meetingId: z.string().nullish(),
          leadId: z.string().nullish(),
        }),
      },
    },
    async (req) => {
      const body = req.body
      // `source` marks where it came from, so a flood from a misfiring workflow
      // can be cleared out without taking hand-written tasks with it. The row
      // itself is built where every other caller builds it, so a task from a
      // workflow carries the same client and the same place in its column as
      // one created by hand.
      return createTask({ ...body, source: 'MCP' })
    },
  )

  /**
   * Tick a task off — through the same rule the board uses.
   *
   * This used to write `done: true` and emit the event itself, which skipped
   * the one thing that makes closing a follow-up's ticket mean something: the
   * lead's follow-up stays open, waiting on a date nobody can see any more.
   */
  app.post('/tasks/:id/complete', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return completeTask(id, (message) => app.log.warn(message))
  })

  // --- Time ----------------------------------------------------------------

  app.post(
    '/time',
    {
      schema: {
        body: z.object({
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
        }),
      },
    },
    async (req) => {
      const body = req.body

      // The column is seconds; the API takes minutes. Converting at the edge
      // keeps every report downstream on one unit.
      const durationSec = body.minutes * 60
      const startedAt = body.startedAt ?? new Date(Date.now() - durationSec * 1000)

      // Through the service, so the booking carries an hourly rate and a
      // client. Written here directly it carried neither, and an hour booked by
      // a workflow was worth nothing on the invoice while the same hour booked
      // by hand was worth the project's rate.
      return logTime({
        projectId: body.projectId,
        description: body.description,
        startedAt,
        endedAt: new Date(startedAt.getTime() + durationSec * 1000),
        billable: body.billable,
        tags: body.tags,
        // TimeSource has no value for "automation", and adding one is a
        // migration for a label. MCP is what it has always said here.
        source: 'MCP',
      })
    },
  )

  // --- Notes ---------------------------------------------------------------

  /**
   * Finding a note back.
   *
   * This exists for the contract workflows: when Zoho reports a signature,
   * all it knows is its own request id, and the note written on sending is
   * what ties that id to a customer. Searching the title is enough for that
   * and keeps the surface small — the bodies of all notes are not something a
   * workflow has any business paging through.
   */
  app.get(
    '/notes',
    {
      schema: {
        querystring: z.object({
          q: z.string().optional(),
          clientId: z.string().optional(),
          projectId: z.string().optional(),
          limit: z.coerce.number().max(100).default(20),
        }),
      },
    },
    async (req) => {
      const q = req.query

      return prisma.note.findMany({
        where: {
          ...(q.q ? { title: { contains: q.q, mode: 'insensitive' } } : {}),
          ...(q.clientId ? { clientId: q.clientId } : {}),
          ...(q.projectId ? { projectId: q.projectId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        select: {
          id: true,
          title: true,
          body: true,
          tags: true,
          clientId: true,
          projectId: true,
          createdAt: true,
        },
      })
    },
  )

  app.post(
    '/notes',
    {
      schema: {
        body: z.object({
          title: z.string().min(1),
          body: z.string().default(''),
          tags: z.array(z.string()).default([]),
          projectId: z.string().nullish(),
          clientId: z.string().nullish(),
        }),
      },
    },
    async (req) => {
      const body = req.body

      const note = await prisma.note.create({ data: body })
      await emitAutomationEvent({
        event: 'NOTE_CREATED',
        projectId: note.projectId,
        path: '/notes',
        data: { id: note.id, title: note.title, tags: note.tags, projectId: note.projectId },
      })
      return note
    },
  )

  // --- Contracts -----------------------------------------------------------

  /**
   * The contract a signing event belongs to.
   *
   * Found by the Zoho request id, which the API wrote when it sent the
   * contract. The row carries `fileName` as well: the name the signed PDF is
   * to be written under. The workflow cannot compute it — the rule lives in
   * services/contracts.ts and a second implementation inside a code node
   * would drift on the first renamed field — so it is handed out here, and
   * the workflow writes the file and hands the same name back.
   */
  app.get(
    '/contracts',
    {
      schema: {
        querystring: z.object({
          externalId: z.string().optional(),
          clientId: z.string().optional(),
          status: z.string().optional(),
          limit: z.coerce.number().max(100).default(20),
        }),
      },
    },
    async (req) => {
      const q = req.query

      const rows = await prisma.contract.findMany({
        where: {
          ...(q.externalId ? { externalId: q.externalId } : {}),
          ...(q.clientId ? { clientId: q.clientId } : {}),
          ...(q.status ? { status: q.status } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: q.limit,
        select: {
          id: true,
          clientId: true,
          projectId: true,
          type: true,
          title: true,
          status: true,
          externalId: true,
          taskId: true,
          file: true,
          signedOn: true,
          endsOn: true,
          createdAt: true,
        },
      })

      return rows.map((row) => ({
        ...row,
        fileName:
          row.file ??
          signedFileName({
            clientId: row.clientId,
            title: row.title,
            unique: row.externalId ?? row.id,
            on: new Date(),
          }),
      }))
    },
  )

  /**
   * Signed, by both sides.
   *
   * One call for the whole state change — status, date, file, and the
   * "Signatur ausstehend" task — because a workflow that does it in three
   * calls can stop after the first. The task goes through the same service
   * the interface uses, so a follow-up hanging off it closes with it.
   */
  app.post(
    '/contracts/:id/signed',
    {
      schema: {
        params: idParam,
        body: z.object({
          /** File name inside the contract directory, as handed out above. */
          file: z.string().nullish(),
          signedOn: z.coerce.date().optional(),
        }),
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const body = req.body

      const contract = await prisma.contract.findUnique({ where: { id } })
      if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })

      // A name that does not resolve into the contract directory is dropped
      // rather than stored: it would be a file nobody can open, recorded as
      // if there were one. Logged, because the workflow has written those
      // bytes somewhere by now and nothing else will mention them.
      let file = contract.file
      if (body.file && resolveSignedPath(body.file)) {
        file = body.file
      } else if (body.file) {
        app.log.warn(
          { contract: id, file: body.file },
          'Dateiname ausserhalb der Vertragsablage — nicht uebernommen',
        )
      }

      const updated = await prisma.contract.update({
        where: { id },
        data: { status: 'signiert', signedOn: body.signedOn ?? new Date(), file },
      })

      if (contract.taskId) await completeTask(contract.taskId, (message) => app.log.warn(message))

      return updated
    },
  )
}

export default routes
