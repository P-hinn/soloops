import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { health, importTemplate, listTemplates, syncAutomations } from '../services/automations.js'
import { EVENT_LABEL, EVENT_WIRE } from '../services/automationEvents.js'
import { FAIL_STREAK_LIMIT } from '../services/automationDelivery.js'
import { createToken } from '../services/automationTokens.js'
import {
  N8nError,
  deleteWorkflow,
  editorUrl,
  getApiKey,
  probe,
  setApiKey,
  setWorkflowActive,
} from '../services/n8n.js'

const idParam = z.object({ id: z.string() })

const automationEvent = z.enum([
  'LEAD_CREATED',
  'LEAD_STAGE_CHANGED',
  'LEAD_WON',
  'LEAD_LOST',
  'LEAD_FOLLOW_UP_DUE',
  'PROJECT_CREATED',
  'MEETING_ENDED',
  'TASK_COMPLETED',
  'NOTE_CREATED',
])

/**
 * The interface side of the automations.
 *
 * Everything here is behind the ordinary gate — an automation token is
 * explicitly *not* allowed in, which is what keeps a workflow from minting
 * itself a second token or reading the delivery log. The workflows' own
 * surface is routes/automationConnector.ts.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  /** n8n errors carry a status worth passing on — 503 for "no key" especially. */
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof N8nError) {
      return reply.code(error.status).send({ error: error.message })
    }
    throw error
  })

  // --- Status --------------------------------------------------------------

  /**
   * What the view needs before it can render anything: is n8n there, is the
   * key accepted, and where does the iframe point.
   */
  app.get('/status', async () => {
    const [state, apiKey, flows, failing] = await Promise.all([
      probe(),
      getApiKey(),
      prisma.automationFlow.count(),
      prisma.automationFlow.count({ where: { failStreak: { gt: 0 } } }),
    ])
    return {
      ...state,
      hasApiKey: !!apiKey,
      /** Same-origin on purpose — anything else and the iframe stays empty. */
      editorUrl: editorUrl(),
      flows,
      failing,
      events: automationEvent.options.map((event) => ({
        event,
        wire: EVENT_WIRE[event],
        label: EVENT_LABEL[event],
      })),
    }
  })

  /**
   * The key cannot be handed to n8n from outside — it is created inside the
   * editor under Settings -> n8n API. So it arrives here afterwards, and is
   * checked before it is kept: a key that does not work is a worse state than
   * no key, because the view would claim to be configured.
   */
  app.post('/api-key', async (req, reply) => {
    const body = z.object({ apiKey: z.string().min(10) }).parse(req.body)
    const previous = await getApiKey()
    await setApiKey(body.apiKey)
    const state = await probe()
    if (!state.authorized) {
      await setApiKey(previous)
      return reply.code(400).send({ error: state.error ?? 'n8n hat den Key nicht akzeptiert' })
    }
    return { ok: true, ...state }
  })

  app.delete('/api-key', async () => {
    await setApiKey(null)
    return { ok: true }
  })

  // --- Flows ---------------------------------------------------------------

  app.get('/flows', async () => {
    const flows = await prisma.automationFlow.findMany({
      orderBy: [{ missingSince: 'asc' }, { lastRunAt: 'desc' }, { name: 'asc' }],
      include: {
        project: { select: { id: true, key: true, name: true, color: true } },
        triggers: {
          select: { id: true, event: true, enabled: true, failStreak: true, lastError: true },
        },
        runs: {
          orderBy: { startedAt: 'desc' },
          take: 12,
          select: {
            id: true,
            status: true,
            startedAt: true,
            durationMs: true,
            error: true,
            mode: true,
          },
        },
      },
    })
    return flows.map((flow) => ({
      ...flow,
      health: health(flow),
      editorUrl: editorUrl(flow.n8nId),
    }))
  })

  /** Assigning a flow to a project — the one thing n8n has no concept of. */
  app.patch('/flows/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ projectId: z.string().nullable() }).parse(req.body)
    return prisma.automationFlow.update({ where: { id }, data: { projectId: body.projectId } })
  })

  /** On and off. Decided in n8n, then mirrored — not the other way round. */
  app.post('/flows/:id/active', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({ active: z.boolean() }).parse(req.body)
    const flow = await prisma.automationFlow.findUniqueOrThrow({ where: { id } })
    const updated = await setWorkflowActive(flow.n8nId, body.active)
    return prisma.automationFlow.update({
      where: { id },
      data: { active: updated.active ?? body.active },
    })
  })

  /**
   * Delete in n8n and here. A workflow already gone from n8n is not an error —
   * the point of the call was to be rid of it.
   */
  app.delete('/flows/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const flow = await prisma.automationFlow.findUniqueOrThrow({ where: { id } })
    try {
      await deleteWorkflow(flow.n8nId)
    } catch (err) {
      if (!(err instanceof N8nError) || err.status !== 404) throw err
    }
    await prisma.automationFlow.delete({ where: { id } })
    return { ok: true }
  })

  // --- Runs ----------------------------------------------------------------

  /** The monitoring feed: every run across every flow, newest first. */
  app.get('/runs', async (req) => {
    const q = z
      .object({
        take: z.coerce.number().max(200).default(50),
        status: z
          .enum(['NEW', 'RUNNING', 'WAITING', 'SUCCESS', 'ERROR', 'CANCELED', 'UNKNOWN'])
          .optional(),
        flowId: z.string().optional(),
      })
      .parse(req.query)

    return prisma.automationRun.findMany({
      where: { status: q.status, flowId: q.flowId },
      orderBy: { startedAt: 'desc' },
      take: q.take,
      include: { flow: { select: { id: true, name: true, n8nId: true } } },
    })
  })

  app.post('/sync', async () => syncAutomations())

  // --- Templates -----------------------------------------------------------

  app.get('/templates', async () => listTemplates())

  /**
   * Drop a template into n8n. It lands inactive: the credential has to be
   * picked by hand, and a template that switched itself on would run with a
   * blank one.
   */
  app.post('/templates/:slug/import', async (req) => {
    const { slug } = z.object({ slug: z.string() }).parse(req.params)
    const body = z
      .object({ projectId: z.string().nullish(), name: z.string().optional() })
      .parse(req.body ?? {})
    const { flow, n8nId } = await importTemplate(slug, body)
    return { flow, editorUrl: editorUrl(n8nId) }
  })

  // --- Triggers (soloops -> n8n) -------------------------------------------

  /**
   * The registered webhooks. Normally created by the Soloops Trigger node on
   * activation rather than by hand here — this is the list and the switch.
   */
  app.get('/triggers', async () => {
    const triggers = await prisma.automationTrigger.findMany({
      orderBy: [{ enabled: 'desc' }, { event: 'asc' }],
      include: {
        flow: { select: { id: true, name: true, n8nId: true } },
        project: { select: { id: true, key: true } },
        deliveries: { orderBy: { at: 'desc' }, take: 5 },
      },
    })
    return triggers.map((trigger) => ({
      ...trigger,
      wire: EVENT_WIRE[trigger.event],
      label: EVENT_LABEL[trigger.event],
      /** Switched itself off after too many failures, rather than by hand. */
      disabledByFailures: !trigger.enabled && trigger.failStreak >= FAIL_STREAK_LIMIT,
      // The secret never leaves the server.
      secretEnc: undefined,
    }))
  })

  app.patch('/triggers/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({ enabled: z.boolean().optional(), projectId: z.string().nullish() })
      .parse(req.body)
    return prisma.automationTrigger.update({
      where: { id },
      data: {
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
        // Switching one back on is also forgiving its history, otherwise the
        // next single failure trips the limit again.
        ...(body.enabled ? { failStreak: 0, lastError: null } : {}),
      },
    })
  })

  app.delete('/triggers/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    await prisma.automationTrigger.delete({ where: { id } })
    return { ok: true }
  })

  /** Every outbound attempt — what makes a silently dead webhook visible. */
  app.get('/deliveries', async (req) => {
    const q = z
      .object({
        take: z.coerce.number().max(200).default(50),
        triggerId: z.string().optional(),
        failedOnly: z.coerce.boolean().optional(),
      })
      .parse(req.query)
    return prisma.automationDelivery.findMany({
      where: { triggerId: q.triggerId, ...(q.failedOnly ? { ok: false } : {}) },
      orderBy: { at: 'desc' },
      take: q.take,
      include: { trigger: { select: { id: true, event: true, webhookUrl: true } } },
    })
  })

  // --- Tokens (n8n -> soloops) --------------------------------------------

  app.get('/tokens', async () => {
    const tokens = await prisma.automationToken.findMany({
      orderBy: [{ revokedAt: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        name: true,
        prefix: true,
        scopes: true,
        lastUsedAt: true,
        revokedAt: true,
        createdAt: true,
      },
    })
    return {
      tokens,
      /** What goes into the n8n credential next to the token. */
      baseUrl: `http://api:${env.PORT}`,
    }
  })

  /**
   * Mint one. The token itself is in this response and nowhere else — only
   * its hash is stored, so a lost one is replaced rather than recovered.
   */
  app.post('/tokens', async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        scopes: z.array(z.enum(['read', 'write'])).default(['read', 'write']),
      })
      .parse(req.body)
    const created = await createToken(body.name, body.scopes)
    return {
      ...created,
      baseUrl: `http://api:${env.PORT}`,
      note: 'Dieser Token wird nur jetzt angezeigt.',
    }
  })

  /**
   * Revoked, not deleted. The row keeps proving that this prefix was once a
   * real token, which is the difference between "revoked" and "never existed"
   * when something starts failing.
   */
  app.post('/tokens/:id/revoke', async (req) => {
    const { id } = idParam.parse(req.params)
    return prisma.automationToken.update({
      where: { id },
      data: { revokedAt: new Date() },
      select: { id: true, name: true, prefix: true, revokedAt: true },
    })
  })

  app.delete('/tokens/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    await prisma.automationToken.delete({ where: { id } })
    return { ok: true }
  })
}

export default routes
