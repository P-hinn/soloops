import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { vaultItemInput } from '@soloops/shared'
import { prisma } from '../db.js'

const idParam = z.object({ id: z.string() })

/**
 * Der Server ist hier bewusst dumm: er speichert `cipherText` + `iv` und
 * durchsucht nur die Klartext-Metadaten (Titel, URL, Ordner, Tags).
 * Ver- und Entschlüsselung passiert ausschließlich im Browser
 * (siehe apps/web/src/lib/crypto.ts).
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({ q: z.string().optional(), folder: z.string().optional(), projectId: z.string().optional() })
      .parse(req.query)

    return prisma.vaultItem.findMany({
      where: {
        ...(q.folder ? { folder: q.folder } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.q
          ? {
              OR: [
                { title: { contains: q.q, mode: 'insensitive' } },
                { username: { contains: q.q, mode: 'insensitive' } },
                { url: { contains: q.q, mode: 'insensitive' } },
                { tags: { has: q.q } },
              ],
            }
          : {}),
      },
      orderBy: [{ folder: 'asc' }, { title: 'asc' }],
      include: { project: { select: { id: true, key: true } } },
    })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const item = await prisma.vaultItem.findUnique({ where: { id } })
    if (!item) return reply.code(404).send({ error: 'Eintrag nicht gefunden' })
    await prisma.vaultItem.update({ where: { id }, data: { lastUsedAt: new Date() } })
    return item
  })

  app.post('/', async (req, reply) => {
    const data = vaultItemInput.parse(req.body)
    return reply.code(201).send(await prisma.vaultItem.create({ data }))
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = vaultItemInput.partial().parse(req.body)
    return prisma.vaultItem.update({ where: { id }, data })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await prisma.vaultItem.delete({ where: { id } })
    return reply.code(204).send()
  })

  app.get('/meta/folders', async () => {
    const rows = await prisma.vaultItem.groupBy({ by: ['folder'], _count: true })
    return rows
      .filter((r) => r.folder)
      .map((r) => ({ folder: r.folder as string, count: r._count }))
      .sort((a, b) => a.folder.localeCompare(b.folder))
  })
}

export default routes
