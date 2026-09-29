import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { noteInput } from '@soloops/shared'
import { prisma } from '../db.js'

const idParam = z.object({ id: z.string() })

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({
        projectId: z.string().optional(),
        clientId: z.string().optional(),
        tag: z.string().optional(),
        q: z.string().optional(),
        take: z.coerce.number().max(200).default(100),
      })
      .parse(req.query)

    if (q.q) {
      // Full text through the GIN index (see db.ts)
      const rows = await prisma.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM "Note"
        WHERE to_tsvector('german', coalesce(title,'') || ' ' || coalesce(body,''))
              @@ websearch_to_tsquery('german', ${q.q})
        ORDER BY "updatedAt" DESC
        LIMIT ${q.take}
      `
      const ids = rows.map((r) => r.id)
      const notes = await prisma.note.findMany({
        where: { id: { in: ids } },
        include: { project: { select: { id: true, key: true, color: true } } },
      })
      return ids.map((id) => notes.find((n) => n.id === id)).filter(Boolean)
    }

    return prisma.note.findMany({
      where: {
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.clientId ? { clientId: q.clientId } : {}),
        ...(q.tag ? { tags: { has: q.tag } } : {}),
      },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: q.take,
      include: { project: { select: { id: true, key: true, color: true } } },
    })
  })

  app.get('/tags', async () => {
    const notes = await prisma.note.findMany({ select: { tags: true } })
    const counts = new Map<string, number>()
    for (const n of notes) for (const t of n.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
  })

  app.get('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const note = await prisma.note.findUnique({
      where: { id },
      include: { project: true, client: true, meeting: true },
    })
    if (!note) return reply.code(404).send({ error: 'Notiz nicht gefunden' })
    return note
  })

  app.post('/', async (req, reply) => {
    const data = noteInput.parse(req.body)
    return reply.code(201).send(await prisma.note.create({ data }))
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    const data = noteInput.partial().parse(req.body)
    return prisma.note.update({ where: { id }, data })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await prisma.note.delete({ where: { id } })
    return reply.code(204).send()
  })
}

export default routes
