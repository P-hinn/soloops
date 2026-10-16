import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { invoiceFromTimeInput, invoiceInput } from '@soloops/shared'
import { renderInvoicePdf } from '@soloops/core/services/invoicePdf.js'
import {
  createInvoice,
  deleteInvoice,
  getInvoice,
  invoiceForPdf,
  invoiceFromTime,
  listInvoices,
  setInvoiceStatus,
  updateInvoice,
} from '@soloops/core/services/invoices.js'

const idParam = z.object({ id: z.string() })

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        clientId: z.string().optional(),
        year: z.coerce.number().optional(),
      })
      .parse(req.query)
    return listInvoices(q)
  })

  app.get('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return getInvoice(id)
  })

  app.post('/', async (req, reply) => {
    const data = invoiceInput.parse(req.body)
    return reply.code(201).send(await createInvoice(data))
  })

  /**
   * Draft an invoice out of the booked hours of a period. Every entry in the
   * period becomes a line item and is then linked firmly, so that none of it
   * can end up on a second invoice.
   */
  app.post('/from-time', async (req, reply) => {
    const data = invoiceFromTimeInput.parse(req.body)
    return reply.code(201).send(await invoiceFromTime(data))
  })

  app.patch('/:id', async (req) => {
    const { id } = idParam.parse(req.params)
    return updateInvoice(id, invoiceInput.partial().parse(req.body))
  })

  app.post('/:id/status', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({ status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']) })
      .parse(req.body)
    return setInvoiceStatus(id, body.status)
  })

  app.get('/:id/pdf', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const invoice = await invoiceForPdf(id)
    const pdf = await renderInvoicePdf(invoice)
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `inline; filename="${invoice.number}.pdf"`)
    return reply.send(pdf)
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    await deleteInvoice(id)
    return reply.code(204).send()
  })
}

export default routes
