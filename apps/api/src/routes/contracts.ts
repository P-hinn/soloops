import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { prisma } from '@soloops/core/db.js'
import { env } from '@soloops/core/env.js'
import {
  buildContractRows,
  CONTRACT_PREFIX,
  CONTRACT_TYPES,
  resolveSignedPath,
} from '@soloops/core/services/contracts.js'
import { getExecution, listExecutions, listWorkflows } from '@soloops/core/services/n8n.js'

/**
 * Sending a contract, and seeing what came of it.
 *
 * The work happens in n8n: render the template, hand it to Zoho Sign, write
 * the result back through the connector. soloops does two things around that
 * — it starts the workflow, and it answers "who has what, in what state".
 *
 * Starting it goes through here rather than straight from the browser for
 * three reasons: the webhook lives inside the compose network and is not
 * reachable from a browser, the n8n error message is worth passing on rather
 * than losing to CORS, and a workflow that can be triggered from any page the
 * user has open is a workflow anyone's browser can trigger.
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

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

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
          vertrag: z.enum(CONTRACT_TYPES),
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
      const payload = safeJson(text)

      if (!res.ok) {
        const generic =
          (payload as { message?: string } | null)?.message ??
          (text.slice(0, 400) || res.statusText)
        const detail = (await lastWorkflowError()) ?? generic
        return reply.code(502).send({ error: `Vertrag nicht verschickt: ${detail}` })
      }

      return payload ?? { status: 'versendet' }
    },
  )

  /**
   * Who has which contract in what state.
   *
   * Read out of the `[VERTRAG]` notes rather than a table of its own — see
   * services/contracts.ts for why. The outstanding signatures come from the
   * open tasks, so a contract that was never signed keeps showing up as work
   * rather than as a line in a list nobody opens.
   */
  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          clientId: z.string().optional(),
          take: z.coerce.number().max(500).default(200),
        }),
      },
    },
    async (req) => {
      const q = req.query

      const notes = await prisma.note.findMany({
        where: {
          title: { startsWith: CONTRACT_PREFIX },
          ...(q.clientId ? { clientId: q.clientId } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: q.take,
        include: { client: { select: { id: true, name: true, company: true } } },
      })

      const openTasks = await prisma.actionItem.findMany({
        where: { done: false, title: { startsWith: 'Signatur ausstehend' } },
        select: { id: true, title: true, dueOn: true, clientId: true },
      })

      const rows = buildContractRows(notes, openTasks)

      return {
        rows,
        openCount: rows.filter((row) => row.status === 'versendet').length,
      }
    },
  )

  /**
   * The signed PDF.
   *
   * The path comes out of the note, which a workflow wrote — so it is checked
   * against the one directory it may come from before anything is opened. A
   * note is editable, and `Datei: ../../etc/passwd` must not be a way to read
   * the disk.
   */
  app.get(
    '/file',
    { schema: { querystring: z.object({ path: z.string().min(1) }) } },
    async (req, reply) => {
      const { path } = req.query

      const full = resolveSignedPath(path)
      if (!full) {
        return reply.code(400).send({ error: 'Kein zulässiger Pfad in der Vertragsablage' })
      }

      try {
        await stat(full)
      } catch {
        return reply.code(404).send({ error: 'Datei nicht gefunden' })
      }

      return reply
        .type('application/pdf')
        .header('Content-Disposition', `inline; filename="${full.split('/').pop()}"`)
        .send(createReadStream(full))
    },
  )
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

export default routes
