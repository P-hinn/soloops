import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { contactInput } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { withCleanEmail } from '@soloops/core/services/writeFields.js'

const idParam = z.object({ id: z.string() })

/**
 * Make this contact the only primary one at its client.
 *
 * Done as its own statement rather than a unique index: a client may have no
 * primary contact at all, and a partial unique index would make swapping the
 * flag between two people a two-step dance that fails in the middle.
 */
async function clearOtherPrimaries(clientId: string, keep: string): Promise<void> {
  await prisma.contact.updateMany({
    where: { clientId, primary: true, id: { not: keep } },
    data: { primary: false },
  })
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({
        clientId: z.string().optional(),
        includeArchived: z.coerce.boolean().default(false),
        q: z.string().optional(),
      })
      .parse(req.query)

    const text = q.q?.trim()
    return prisma.contact.findMany({
      where: {
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(q.includeArchived ? {} : { archived: false }),
        ...(text
          ? {
              OR: [
                { name: { contains: text, mode: 'insensitive' as const } },
                { email: { contains: text, mode: 'insensitive' as const } },
                { role: { contains: text, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      // The primary contact first: in a list of five people at one company
      // that is the one being looked for.
      orderBy: [{ primary: 'desc' }, { name: 'asc' }],
      include: { client: { select: { id: true, name: true, company: true } } },
    })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const contact = await prisma.contact.findUnique({
      where: { id },
      include: { client: { select: { id: true, name: true, company: true } } },
    })
    if (!contact) return reply.code(404).send({ error: 'Kontakt nicht gefunden' })
    return contact
  })

  app.post('/', async (req, reply) => {
    const body = contactInput.extend({ clientId: z.string() }).parse(req.body)
    const client = await prisma.client.findUnique({ where: { id: body.clientId } })
    if (!client) return reply.code(404).send({ error: 'Kunde nicht gefunden' })

    const created = await prisma.contact.create({ data: withCleanEmail(body) })
    if (created.primary) await clearOtherPrimaries(created.clientId, created.id)
    return reply.code(201).send(created)
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    // `clientId` is accepted here as well: moving a person to another
    // customer is the same edit as correcting their phone number, and a
    // contact nobody can re-file is a contact that gets entered twice.
    const body = contactInput.partial().extend({ clientId: z.string().optional() }).parse(req.body)

    if (body.clientId) {
      const client = await prisma.client.findUnique({ where: { id: body.clientId } })
      if (!client) return reply.code(404).send({ error: 'Kunde nicht gefunden' })
    }

    const updated = await prisma.contact.update({ where: { id }, data: withCleanEmail(body) })
    if (updated.primary) await clearOtherPrimaries(updated.clientId, updated.id)
    return updated
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await prisma.contact.delete({ where: { id } })
    return reply.code(204).send()
  })
}

export default routes
