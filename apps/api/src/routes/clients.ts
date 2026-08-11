import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { clientInput } from '@soloops/shared'
import { prisma } from '../db.js'

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z.object({ includeArchived: z.coerce.boolean().default(false) }).parse(req.query)
    return prisma.client.findMany({
      where: q.includeArchived ? {} : { archived: false },
      orderBy: { name: 'asc' },
      include: { _count: { select: { projects: true, invoices: true } } },
    })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const client = await prisma.client.findUnique({
      where: { id },
      include: {
        projects: { orderBy: { name: 'asc' } },
        invoices: { orderBy: { issueDate: 'desc' }, take: 20 },
      },
    })
    if (!client) return reply.code(404).send({ error: 'Kunde nicht gefunden' })
    return client
  })

  app.post('/', async (req, reply) => {
    const data = clientInput.parse(req.body)
    const created = await prisma.client.create({
      data: { ...data, email: data.email || null },
    })
    return reply.code(201).send(created)
  })

  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const data = clientInput.partial().parse(req.body)
    return prisma.client.update({ where: { id }, data: { ...data, email: data.email || null } })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const invoices = await prisma.invoice.count({ where: { clientId: id } })
    if (invoices > 0) {
      // Rechnungen sind aufbewahrungspflichtig — Kunde wird nur archiviert.
      await prisma.client.update({ where: { id }, data: { archived: true } })
      return { archived: true, reason: `${invoices} Rechnung(en) vorhanden` }
    }
    await prisma.client.delete({ where: { id } })
    return reply.code(204).send()
  })
}

export default routes
