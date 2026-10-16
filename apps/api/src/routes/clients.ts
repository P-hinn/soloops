import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { clientInput, clientsQuery, idParam } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { notFound } from '@soloops/core/rules.js'
import { withCleanEmail } from '@soloops/core/services/writeFields.js'

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', { schema: { querystring: clientsQuery } }, async (req) => {
    return prisma.client.findMany({
      where: req.query.includeArchived ? {} : { archived: false },
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { projects: true, invoices: true, contacts: true, contracts: true } },
      },
    })
  })

  app.get('/:id', { schema: { params: idParam } }, async (req) => {
    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      include: {
        contacts: {
          where: { archived: false },
          orderBy: [{ primary: 'desc' }, { name: 'asc' }],
        },
        contracts: {
          where: { archived: false },
          orderBy: { createdAt: 'desc' },
        },
        projects: { orderBy: { name: 'asc' } },
        invoices: { orderBy: { issueDate: 'desc' }, take: 20 },
      },
    })
    if (!client) throw notFound('Kunde nicht gefunden')
    return client
  })

  app.post('/', { schema: { body: clientInput } }, async (req, reply) => {
    const created = await prisma.client.create({ data: withCleanEmail(req.body) })
    return reply.code(201).send(created)
  })

  app.patch('/:id', { schema: { params: idParam, body: clientInput.partial() } }, async (req) => {
    return prisma.client.update({
      where: { id: req.params.id },
      data: withCleanEmail(req.body),
    })
  })

  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const invoices = await prisma.invoice.count({ where: { clientId: id } })
    if (invoices > 0) {
      // Invoices have to be retained by law — the client is only archived.
      await prisma.client.update({ where: { id }, data: { archived: true } })
      return { archived: true, reason: `${invoices} Rechnung(en) vorhanden` }
    }
    await prisma.client.delete({ where: { id } })
    return reply.code(204).send()
  })
}

export default routes
