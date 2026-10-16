import { createReadStream } from 'node:fs'
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { contractInput, idParam, SendableContractType } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { env } from '@soloops/core/env.js'
import { resolveSignedPath, signedFileName, SIGNED_ROOT } from '@soloops/core/services/contracts.js'
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
        // Newest first, but a contract still being signed stays on top: that
        // is the one with something left to do.
        orderBy: [{ createdAt: 'desc' }],
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
      const client = await prisma.client.findUnique({ where: { id: body.clientId } })
      if (!client) return reply.code(404).send({ error: 'Kunde nicht gefunden' })

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

      if (body.clientId) {
        const client = await prisma.client.findUnique({ where: { id: body.clientId } })
        if (!client) return reply.code(404).send({ error: 'Kunde nicht gefunden' })
      }

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
    await removeFile(contract.file)
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
      // A PDF starts with %PDF-. Not a guarantee of anything, but it catches
      // the common mistake of sending the wrong file.
      if (!body.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        return reply.code(422).send({ error: 'Die Datei ist kein PDF' })
      }

      const contract = await prisma.contract.findUnique({ where: { id } })
      if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })

      const name = signedFileName({
        clientId: contract.clientId,
        title: contract.title,
        unique: contract.id,
        on: new Date(),
      })
      const target = resolveSignedPath(name)
      if (!target) {
        // Unreachable with a name this code built — but the path check is the
        // security boundary, so it is not bypassed just because it should hold.
        return reply.code(500).send({ error: 'Dateiname nicht zulässig' })
      }

      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, body)
      if (contract.file && contract.file !== name) await removeFile(contract.file)

      return prisma.contract.update({
        where: { id },
        data: { file: name },
        include: INCLUDE,
      })
    },
  )

  app.delete('/:id/file', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const contract = await prisma.contract.findUnique({ where: { id } })
    if (!contract) return reply.code(404).send({ error: 'Vertrag nicht gefunden' })

    await removeFile(contract.file)
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
    // disk, which carries ids nobody wants in their download folder.
    const download = `${contract.title.replace(/[^\w\s.-]/g, '')}.pdf`.replace(/\s+/g, '-')
    return reply
      .type('application/pdf')
      .header('Content-Disposition', `inline; filename="${download}"`)
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
      const contract = await prisma.contract.create({
        data: {
          clientId: body.clientId,
          type: body.vertrag,
          title: payload?.vertrag?.trim() || body.vertrag,
          status: 'versendet',
          externalId: payload?.zoho_request_id ?? null,
          taskId: (await taskOrNull(payload?.aufgabe_id)) ?? null,
        },
        include: INCLUDE,
      })

      return { ...(payload ?? { status: 'versendet' }), vertrag_id: contract.id }
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

/** Best effort: a PDF that is already gone is the state we wanted. */
async function removeFile(name: string | null): Promise<void> {
  if (!name) return
  const full = resolveSignedPath(name)
  if (!full) return
  try {
    await unlink(full)
  } catch {
    // Missing, or a directory somebody made read-only. The record is what
    // counts, and it no longer points at the file.
  }
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export default routes
