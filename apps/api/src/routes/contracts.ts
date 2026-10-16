import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { contractInput, idParam, SendableContractType } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { env } from '@soloops/core/env.js'
import {
  isPdf,
  removeContractFile,
  resolveSignedPath,
  signedFileName,
  SIGNED_ROOT,
  storeContractFile,
} from '@soloops/core/services/contracts.js'
import { getExecution, listExecutions, listWorkflows } from '@soloops/core/services/n8n.js'

/**
 * Contracts at a customer.
 *
 * Two ways in, one table. soloops can generate one of four contracts from a
 * template and send it for signature — that work happens in n8n, this only
 * starts it and files the result. Or a finished document gets uploaded, which
 * is the common case for everything that was agreed before soloops existed or
 * drafted by somebody else's lawyer.
 *
 * Starting the workflow goes through here rather than straight from the
 * browser for three reasons: the webhook lives inside the compose network and
 * is not reachable from a browser, the n8n error message is worth passing on
 * rather than losing to CORS, and a workflow that can be triggered from any
 * page the user has open is a workflow anyone's browser can trigger.
 */

/**
 * How long a send may take.
 *
 * The workflow renders a PDF and talks to Zoho twice, so this is generous —
 * but not unbounded: without it a hanging provider holds the request open for
 * as long as the connection lives, and the interface shows a spinner that
 * never resolves. The rest of the n8n calls in this codebase are bounded the
 * same way, see services/n8n.ts.
 */
const SEND_TIMEOUT_MS = 90_000

/** What a contract PDF may weigh. A scan of twenty pages is about three. */
const MAX_PDF_BYTES = 20 * 1024 * 1024

/** Customer, project and the open signature task, as every row needs them. */
const INCLUDE = {
  client: { select: { id: true, name: true, company: true } },
  project: { select: { id: true, key: true, name: true } },
  task: { select: { id: true, title: true, dueOn: true, done: true } },
} as const

/**
 * Why the workflow stopped.
 *
 * A failing webhook answers "Error in workflow" and keeps the actual reason —
 * "Pflichtfelder fehlen: festpreis", "Beim Kunden fehlt: Straße" — in the
 * execution. Those sentences are the whole point of the checks in the graph,
 * so they get fetched and handed on. Best effort: if n8n cannot be asked, the
 * generic message is still better than nothing.
 */
async function lastWorkflowError(): Promise<string | null> {
  try {
    const flows = await listWorkflows()
    const flow = flows.find((f) => f.name.startsWith('Vertrag versenden'))
    const [run] = await listExecutions({ workflowId: flow?.id, limit: 1, status: 'error' })
    if (!run) return null
    const full = await getExecution(run.id)
    // n8n appends the line number inside the code node ("… [line 38]"), which
    // says nothing to whoever is sending a contract.
    return full.data?.resultData?.error?.message?.replace(/\s*\[line \d+\]\s*$/, '') ?? null
  } catch {
    return null
  }
}

/** The dates arrive as ISO strings and are stored as dates. */
function withDates<T extends Record<string, unknown>>(body: T) {
  const parsed = { ...body } as Record<string, unknown>
  for (const key of ['signedOn', 'startsOn', 'endsOn'] as const) {
    if (!(key in parsed)) continue
    const value = parsed[key]
    parsed[key] = value ? new Date(String(value)) : null
  }
  return parsed as T
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  /**
   * The PDF arrives as the body itself, not as a multipart form.
   *
   * One file per request, no fields alongside it — so a form buys nothing but
   * a dependency and a parser. `parseAs: 'buffer'` hands the bytes over
   * unchanged; the length is capped by `bodyLimit` on the route.
   */
  app.addContentTypeParser(
    'application/pdf',
    { parseAs: 'buffer', bodyLimit: MAX_PDF_BYTES },
    (_req, body, done) => done(null, body),
  )

  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          clientId: z.string().optional(),
          projectId: z.string().optional(),
          status: z.string().optional(),
          includeArchived: z.coerce.boolean().default(false),
          q: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
      },
    },
    async (req) => {
      const q = req.query
      const text = q.q?.trim()

      return prisma.contract.findMany({
        where: {
          ...(q.clientId ? { clientId: q.clientId } : {}),
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(q.status ? { status: q.status } : {}),
          ...(q.includeArchived ? {} : { archived: false }),
          ...(text
            ? {
                OR: [
                  { title: { contains: text, mode: 'insensitive' as const } },
                  { notes: { contains: text, mode: 'insensitive' as const } },
                  { client: { name: { contains: text, mode: 'insensitive' as const } } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }],
        take: q.limit,
        include: INCLUDE,
      })
    },
  )

  app.get('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const contract = await prisma.contract.findUnique({ where: { id }, include: INCLUDE })
    if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })
    return contract
  })

  app.post(
    '/',
    { schema: { body: contractInput.extend({ clientId: z.string() }) } },
    async (req, reply) => {
      const body = req.body

      const missing = await unknownRelation(body)
      if (missing) return reply.code(404).send({ error: missing })

      const created = await prisma.contract.create({
        data: withDates(body),
        include: INCLUDE,
      })
      return reply.code(201).send(created)
    },
  )

  app.patch(
    '/:id',
    {
      schema: {
        params: idParam,
        body: contractInput.partial().extend({ clientId: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const { id } = req.params
      const body = req.body

      const missing = await unknownRelation(body)
      if (missing) return reply.code(404).send({ error: missing })

      const existing = await prisma.contract.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })

      return prisma.contract.update({ where: { id }, data: withDates(body), include: INCLUDE })
    },
  )

  /**
   * Delete the record and the PDF with it.
   *
   * The file goes too: it was uploaded for this contract and nothing else
   * points at it, so leaving it behind would mean a directory that only ever
   * grows and holds documents nobody can reach any more.
   */
  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const contract = await prisma.contract.findUnique({ where: { id } })
    if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })

    await prisma.contract.delete({ where: { id } })
    await removeContractFile(contract.file)
    return reply.code(204).send()
  })

  /**
   * Put a PDF on a contract.
   *
   * The name is chosen here, not sent along: it carries the customer, the
   * date and the contract id, and a name that came from a browser is a name
   * somebody can choose. Replacing a file deletes the one before it, so the
   * directory holds one PDF per contract.
   */
  app.post(
    '/:id/file',
    { schema: { params: idParam }, bodyLimit: MAX_PDF_BYTES },
    async (req, reply) => {
      const { id } = req.params
      const body = req.body

      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(415).send({
          error: 'Erwartet wird der Inhalt einer PDF-Datei als Content-Type application/pdf',
        })
      }
      if (!isPdf(body)) {
        return reply.code(422).send({ error: 'Die Datei ist kein PDF' })
      }

      const contract = await prisma.contract.findUnique({ where: { id } })
      if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })

      const name = await storeContractFile(
        signedFileName({
          clientId: contract.clientId,
          title: contract.title,
          unique: contract.id,
          on: new Date(),
        }),
        body,
      )

      let updated
      try {
        updated = await prisma.contract.update({
          where: { id },
          data: { file: name },
          include: INCLUDE,
        })
      } catch (err) {
        // The bytes are on disk and nothing points at them. Take them back
        // out, or the directory collects files no record knows about.
        await removeContractFile(name)
        throw err
      }

      if (contract.file && contract.file !== name) await removeContractFile(contract.file)
      return updated
    },
  )

  app.delete('/:id/file', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const contract = await prisma.contract.findUnique({ where: { id } })
    if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })

    await removeContractFile(contract.file)
    return prisma.contract.update({ where: { id }, data: { file: null }, include: INCLUDE })
  })

  /**
   * The PDF itself.
   *
   * Addressed by contract rather than by path: the stored name still goes
   * through `resolveSignedPath`, but nothing outside this file ever has to
   * handle it, and a request cannot name a file of its own.
   */
  app.get('/:id/file', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const contract = await prisma.contract.findUnique({ where: { id } })
    if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })
    if (!contract.file) return reply.code(404).send({ error: 'Zu diesem Vertrag liegt kein PDF' })

    const full = resolveSignedPath(contract.file)
    if (!full) return reply.code(400).send({ error: 'Kein zulässiger Pfad in der Vertragsablage' })

    try {
      await stat(full)
    } catch {
      return reply.code(404).send({
        error: `Die Datei ${contract.file} fehlt in der Ablage — abgelegt ist sie unter ${SIGNED_ROOT}`,
      })
    }

    // The name the browser offers on save: the contract's, not the one on
    // disk, which carries ids nobody wants in their download folder. Letters
    // rather than \w, so "Müller" survives; the whitespace collapse runs last
    // and is what keeps a newline out of the header.
    const download = `${contract.title.replace(/[^\p{L}\p{N}\s.-]/gu, '')}.pdf`.replace(/\s+/g, '-')
    // Two names, per RFC 6266: a header is ASCII, so "Müller" in the plain
    // `filename` arrives as mojibake. The encoded one is what every current
    // browser reads, the plain one is the fallback and stays legible.
    const ascii = download.replace(/[^\x20-\x7E]/g, '-')
    return reply
      .type('application/pdf')
      .header(
        'Content-Disposition',
        `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(download)}`,
      )
      .send(createReadStream(full))
  })

  /**
   * Hand the job to n8n.
   *
   * Everything about the contract itself — which fields are mandatory, what
   * the defaults are, what the PDF looks like — belongs to the workflow and
   * is deliberately not repeated here. This only knows that the webhook takes
   * `{ vertrag, client_id, felder }` and that its answer is worth showing.
   */
  app.post(
    '/send',
    {
      schema: {
        body: z.object({
          vertrag: SendableContractType,
          clientId: z.string(),
          felder: z.record(z.string(), z.string()).default({}),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body

      if (!env.N8N_CONTRACT_WEBHOOK) {
        return reply.code(503).send({
          error:
            'N8N_CONTRACT_WEBHOOK ist nicht gesetzt — ohne die Webhook-URL weiß soloops nicht, wohin der Auftrag geht',
        })
      }

      const client = await prisma.client.findUniqueOrThrow({ where: { id: body.clientId } })
      if (!client.email) {
        return reply.code(422).send({
          error: `${client.name} hat keine E-Mail-Adresse — ohne sie kann Zoho Sign nichts zustellen`,
        })
      }

      let res: Response
      try {
        res = await fetch(env.N8N_CONTRACT_WEBHOOK, {
          method: 'POST',
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          headers: {
            'Content-Type': 'application/json',
            // The webhook is open to whoever can reach n8n, and this one sends
            // documents and costs money per call. The workflow checks it.
            'X-Soloops-Contract-Secret': env.N8N_CONTRACT_WEBHOOK_SECRET,
          },
          body: JSON.stringify({
            vertrag: body.vertrag,
            client_id: body.clientId,
            felder: body.felder,
          }),
        })
      } catch (err) {
        const message =
          (err as Error).name === 'TimeoutError'
            ? `Der Workflow hat nach ${SEND_TIMEOUT_MS / 1000} Sekunden nicht geantwortet — in n8n unter Ausführungen nachsehen, der Vertrag kann trotzdem rausgegangen sein`
            : `n8n nicht erreichbar: ${(err as Error).message}`
        return reply.code(502).send({ error: message })
      }

      const text = await res.text()
      const payload = safeJson(text) as {
        message?: string
        vertrag?: string
        zoho_request_id?: string
        aufgabe_id?: string
      } | null

      if (!res.ok) {
        const generic = payload?.message ?? (text.slice(0, 400) || res.statusText)
        const detail = (await lastWorkflowError()) ?? generic
        return reply.code(502).send({ error: `Vertrag nicht verschickt: ${detail}` })
      }

      /**
       * The contract is filed only now.
       *
       * Before the send there is nothing to file — a failed send would leave
       * a row for a contract that never went out, and that row would be
       * indistinguishable from a draft somebody is working on. The Zoho
       * request id is what the signing webhook finds it by later.
       */
      try {
        const contract = await prisma.contract.create({
          data: {
            clientId: body.clientId,
            type: body.vertrag,
            title: payload?.vertrag?.trim() || body.vertrag,
            status: 'versendet',
            externalId: payload?.zoho_request_id ?? null,
            taskId: (await taskOrNull(payload?.aufgabe_id)) ?? null,
          },
        })
        return { ...(payload ?? { status: 'versendet' }), vertrag_id: contract.id }
      } catch (err) {
        // The contract is out. Failing the request now would report a send
        // that happened as one that did not, and the webhook cannot be taken
        // back — so it is reported next to the success instead.
        app.log.error({ err, zoho: payload?.zoho_request_id }, 'Vertrag versendet, nicht erfasst')
        return {
          ...(payload ?? { status: 'versendet' }),
          vertrag_id: null,
          warnung:
            'Der Vertrag ist raus, konnte aber nicht beim Kunden abgelegt werden — bitte von Hand anlegen, sonst findet die Signatur ihn später nicht.',
        }
      }
    },
  )
}

/**
 * The task id the workflow reports, if it is one.
 *
 * It comes back through a webhook response, and the column is a foreign key —
 * an id that no longer exists would turn a sent contract into a failed
 * request. The link is the nice-to-have here, the contract is not.
 */
async function taskOrNull(id: string | undefined): Promise<string | null> {
  if (!id) return null
  const task = await prisma.actionItem.findUnique({ where: { id }, select: { id: true } })
  return task?.id ?? null
}

/**
 * The first relation in the body that does not exist, as a sentence.
 *
 * Both foreign keys, not just the customer: without this an unknown project
 * reaches Postgres and comes back as a foreign key violation, which the error
 * handler can only turn into a 500 — a request that named something wrong,
 * answered as if the server were broken.
 */
async function unknownRelation(body: {
  clientId?: string
  projectId?: string | null
}): Promise<string | null> {
  if (body.clientId) {
    const client = await prisma.client.findUnique({
      where: { id: body.clientId },
      select: { id: true },
    })
    if (!client) return 'Kunde nicht gefunden'
  }
  if (body.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: body.projectId },
      select: { id: true },
    })
    if (!project) return 'Projekt nicht gefunden'
  }
  return null
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export default routes
