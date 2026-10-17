import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import {
  ATTACHMENT_MAX_BYTES,
  attachmentInput,
  downloadName,
  idParam,
  isInlineSafe,
} from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import {
  attachmentFileName,
  FILE_ROOT,
  removeAttachmentFile,
  resolveAttachmentPath,
  storeAttachmentFile,
} from '@soloops/core/services/attachments.js'

/**
 * Files filed at a customer.
 *
 * The counterpart to the contracts: there, soloops knows what a document is
 * and can generate one — here it only keeps what somebody hands it. The
 * briefing, the logo, the scan of the signed protocol, the subcontractor's
 * invoice. One row per file, and deleting takes the bytes with it.
 *
 * The upload is the bytes as the request body with the metadata in the query
 * string, for the same reason the contract upload is: one file per request
 * and no fields that belong to the file itself, so a multipart form would buy
 * nothing but a parser and a dependency.
 */

/** Customer and project, as every row needs them. */
const INCLUDE = {
  client: { select: { id: true, name: true, company: true } },
  project: { select: { id: true, key: true, name: true } },
} as const

/**
 * The content type, reduced to what may be stored.
 *
 * It comes from a request header and ends up in a response header, so the
 * parameters go ("text/plain; charset=utf-8" says nothing this needs) and
 * anything that is not a plain type/subtype becomes the generic one. That is
 * what keeps a newline out of the Content-Type on the way back out.
 */
function cleanMime(value: string | undefined): string {
  const type = ((value ?? '').split(';')[0] ?? '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(type)
    ? type
    : 'application/octet-stream'
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  /**
   * Any content type, handed over as bytes.
   *
   * A customer file is whatever the customer sent, so the parser cannot be
   * registered per type. JSON keeps its own parser — Fastify prefers the
   * specific one — which is what the PATCH below needs. The length is capped
   * here and again on the route.
   */
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: ATTACHMENT_MAX_BYTES },
    (_req, body, done) => done(null, body),
  )

  app.get(
    '/',
    {
      schema: {
        querystring: z.object({
          clientId: z.string().optional(),
          projectId: z.string().optional(),
          q: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200),
        }),
      },
    },
    async (req) => {
      const q = req.query
      const text = q.q?.trim()

      return prisma.attachment.findMany({
        where: {
          ...(q.clientId ? { clientId: q.clientId } : {}),
          ...(q.projectId ? { projectId: q.projectId } : {}),
          ...(text
            ? {
                OR: [
                  { title: { contains: text, mode: 'insensitive' as const } },
                  { originalName: { contains: text, mode: 'insensitive' as const } },
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
    const found = await prisma.attachment.findUnique({
      where: { id: req.params.id },
      include: INCLUDE,
    })
    if (!found) return reply.code(404).send({ error: 'Datei nicht gefunden' })
    return found
  })

  /**
   * Upload.
   *
   * The record is written after the bytes and under a name that carries its
   * own id — so the name cannot be known before the row exists. The row is
   * therefore created first with a placeholder, then the file is written and
   * the name filed; a write that fails takes the row with it, because a row
   * pointing at nothing is worse than no row.
   */
  app.post(
    '/',
    {
      schema: {
        querystring: z.object({
          clientId: z.string(),
          projectId: z.string().optional(),
          /** The file's own name, as the browser has it. */
          name: z.string().min(1).max(300),
          /** What it is called in soloops. The file name, where not given. */
          title: z.string().max(200).optional(),
          notes: z.string().max(2000).optional(),
        }),
      },
      bodyLimit: ATTACHMENT_MAX_BYTES,
    },
    async (req, reply) => {
      const q = req.query
      const body = req.body

      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(415).send({
          error:
            'Erwartet wird der Inhalt der Datei als Request-Body, mit dem Content-Type der Datei',
        })
      }

      const missing = await unknownRelation(q)
      if (missing) return reply.code(404).send({ error: missing })

      const created = await prisma.attachment.create({
        data: {
          clientId: q.clientId,
          projectId: q.projectId ?? null,
          title: (q.title?.trim() || q.name.trim()).slice(0, 200),
          // Replaced below. Never read in between: the row is not returned
          // and nothing else looks at a file name it does not resolve.
          file: '',
          originalName: q.name.trim().slice(0, 300),
          mime: cleanMime(req.headers['content-type']),
          sizeBytes: body.length,
          notes: q.notes?.trim() || null,
        },
      })

      try {
        const name = await storeAttachmentFile(
          attachmentFileName({
            clientId: created.clientId,
            name: created.originalName,
            unique: created.id,
            on: created.createdAt,
          }),
          body,
        )
        return reply.code(201).send(
          await prisma.attachment.update({
            where: { id: created.id },
            data: { file: name },
            include: INCLUDE,
          }),
        )
      } catch (err) {
        // No bytes, so no file: the row would show a download that answers
        // 404 for as long as somebody keeps it.
        await prisma.attachment.delete({ where: { id: created.id } }).catch(() => {})
        throw err
      }
    },
  )

  app.patch(
    '/:id',
    { schema: { params: idParam, body: attachmentInput.partial() } },
    async (req, reply) => {
      const { id } = req.params

      const missing = await unknownRelation(req.body)
      if (missing) return reply.code(404).send({ error: missing })

      const existing = await prisma.attachment.findUnique({ where: { id } })
      if (!existing) return reply.code(404).send({ error: 'Datei nicht gefunden' })

      return prisma.attachment.update({ where: { id }, data: req.body, include: INCLUDE })
    },
  )

  /**
   * Delete the record and the file with it.
   *
   * There is no archiving here, unlike a contract: the row says nothing the
   * file does not, so keeping it without the bytes would keep a name whose
   * download is broken. Whoever wants the file keeps the file.
   */
  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const found = await prisma.attachment.findUnique({ where: { id } })
    if (!found) return reply.code(404).send({ error: 'Datei nicht gefunden' })

    await prisma.attachment.delete({ where: { id } })
    await removeAttachmentFile(found.file)
    return reply.code(204).send()
  })

  /**
   * The file itself.
   *
   * Addressed by record rather than by path: the stored name still goes
   * through `resolveAttachmentPath`, but a request cannot name a file of its
   * own. Only what cannot execute anything is rendered in place — the rest is
   * downloaded, because an uploaded HTML page served inline from this origin
   * would run with the session in front of it.
   */
  app.get('/:id/file', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const found = await prisma.attachment.findUnique({ where: { id } })
    if (!found) return reply.code(404).send({ error: 'Datei nicht gefunden' })

    const full = found.file ? resolveAttachmentPath(found.file) : null
    if (!full) return reply.code(400).send({ error: 'Kein zulässiger Pfad in der Dateiablage' })

    try {
      await stat(full)
    } catch {
      return reply.code(404).send({
        error: `Die Datei ${found.file} fehlt in der Ablage — abgelegt ist sie unter ${FILE_ROOT}`,
      })
    }

    const download = downloadName(found.title, found.originalName)
    // Two names, per RFC 6266: a header is ASCII, so "Müller" in the plain
    // `filename` arrives as mojibake. The encoded one is what every current
    // browser reads, the plain one is the fallback and stays legible.
    const ascii = download.replace(/[^\x20-\x7E]/g, '-')
    const inline = isInlineSafe(found.mime)

    return (
      reply
        .type(inline ? found.mime : 'application/octet-stream')
        // Without this a .txt the browser decides looks like HTML is HTML.
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(download)}`,
        )
        .send(createReadStream(full))
    )
  })
}

/**
 * The first relation in the body that does not exist, as a sentence.
 *
 * Both foreign keys: without this an unknown project reaches Postgres and
 * comes back as a foreign key violation, which the error handler can only
 * turn into a 500 — a request that named something wrong, answered as if the
 * server were broken.
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

export default routes
