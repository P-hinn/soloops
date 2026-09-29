import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { lexoffice } from '../services/lexoffice.js'

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/status', async () => {
    if (!env.LEXOFFICE_API_KEY) return { provider: 'lexoffice', connected: false }
    try {
      const profile = await lexoffice.profile()
      const pending = await prisma.invoice.count({
        where: { status: { in: ['SENT', 'PAID', 'OVERDUE'] }, lexofficeId: null },
      })
      return { provider: 'lexoffice', connected: true, profile, pending }
    } catch (err) {
      return { provider: 'lexoffice', connected: false, error: (err as Error).message }
    }
  })

  /** Mirror a client to lexoffice (create or update the contact). */
  app.post('/clients/:id/sync', async (req, reply) => {
    if (!env.LEXOFFICE_API_KEY)
      return reply.code(503).send({ error: 'LEXOFFICE_API_KEY nicht gesetzt' })
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const client = await prisma.client.findUniqueOrThrow({ where: { id } })
    const contactId = await lexoffice.upsertContact(client)
    return prisma.client.update({ where: { id }, data: { lexofficeContactId: contactId } })
  })

  /**
   * Transfer an invoice to lexoffice as a finalized document.
   * lexoffice stays the authoritative, GoBD-compliant archive; soloops keeps
   * the mapping to time entries and projects.
   */
  app.post('/invoices/:id/sync', async (req, reply) => {
    if (!env.LEXOFFICE_API_KEY)
      return reply.code(503).send({ error: 'LEXOFFICE_API_KEY nicht gesetzt' })
    const { id } = z.object({ id: z.string() }).parse(req.params)

    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id },
      include: { client: true, items: { orderBy: { position: 'asc' } } },
    })
    if (invoice.status === 'DRAFT') {
      return reply.code(409).send({ error: 'Erst auf "Gestellt" setzen, dann übertragen' })
    }
    if (invoice.lexofficeId) {
      return reply.code(409).send({ error: 'Bereits übertragen', lexofficeId: invoice.lexofficeId })
    }

    let contactId = invoice.client.lexofficeContactId
    if (!contactId) {
      contactId = await lexoffice.upsertContact(invoice.client)
      await prisma.client.update({
        where: { id: invoice.clientId },
        data: { lexofficeContactId: contactId },
      })
    }

    const lexId = await lexoffice.createInvoice(invoice, contactId)
    return prisma.invoice.update({
      where: { id },
      data: { lexofficeId: lexId, lexofficeSyncedAt: new Date() },
    })
  })

  /** Every invoice not yet transferred, in one go. */
  app.post('/invoices/sync-pending', async (_req, reply) => {
    if (!env.LEXOFFICE_API_KEY)
      return reply.code(503).send({ error: 'LEXOFFICE_API_KEY nicht gesetzt' })
    const pending = await prisma.invoice.findMany({
      where: { status: { in: ['SENT', 'PAID', 'OVERDUE'] }, lexofficeId: null },
      include: { client: true, items: { orderBy: { position: 'asc' } } },
    })

    const results: { number: string; ok: boolean; error?: string }[] = []
    for (const invoice of pending) {
      try {
        let contactId = invoice.client.lexofficeContactId
        if (!contactId) {
          contactId = await lexoffice.upsertContact(invoice.client)
          await prisma.client.update({
            where: { id: invoice.clientId },
            data: { lexofficeContactId: contactId },
          })
        }
        const lexId = await lexoffice.createInvoice(invoice, contactId)
        await prisma.invoice.update({
          where: { id: invoice.id },
          data: { lexofficeId: lexId, lexofficeSyncedAt: new Date() },
        })
        results.push({ number: invoice.number, ok: true })
      } catch (err) {
        results.push({ number: invoice.number, ok: false, error: (err as Error).message })
      }
    }
    return { synced: results.filter((r) => r.ok).length, results }
  })

  /** Revenue per month — for tax prepayments and the advance VAT return. */
  app.get('/revenue', async (req) => {
    const q = z
      .object({ year: z.coerce.number().default(new Date().getFullYear()) })
      .parse(req.query)
    const invoices = await prisma.invoice.findMany({
      where: {
        status: { in: ['SENT', 'PAID', 'OVERDUE'] },
        issueDate: { gte: new Date(q.year, 0, 1), lt: new Date(q.year + 1, 0, 1) },
      },
      select: {
        issueDate: true,
        subtotalCents: true,
        taxCents: true,
        totalCents: true,
        status: true,
      },
    })

    const months = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      netCents: 0,
      taxCents: 0,
      grossCents: 0,
      count: 0,
    }))
    for (const inv of invoices) {
      const m = months[inv.issueDate.getMonth()]
      if (!m) continue
      m.netCents += inv.subtotalCents
      m.taxCents += inv.taxCents
      m.grossCents += inv.totalCents
      m.count += 1
    }

    return {
      year: q.year,
      months,
      totalNetCents: months.reduce((s, m) => s + m.netCents, 0),
      totalTaxCents: months.reduce((s, m) => s + m.taxCents, 0),
      totalGrossCents: months.reduce((s, m) => s + m.grossCents, 0),
    }
  })
}

export default routes
