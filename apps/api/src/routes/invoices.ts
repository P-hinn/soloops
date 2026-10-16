import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  idParam,
  invoiceFromTimeInput,
  invoiceInput,
  invoiceStatusInput,
  invoicesQuery,
} from '@soloops/shared'
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

const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', { schema: { querystring: invoicesQuery } }, async (req) => listInvoices(req.query))

  app.get('/:id', { schema: { params: idParam } }, async (req) => {
    const { id } = req.params
    return getInvoice(id)
  })

  app.post('/', { schema: { body: invoiceInput } }, async (req, reply) => {
    const data = req.body
    return reply.code(201).send(await createInvoice(data))
  })

  /**
   * Draft an invoice out of the booked hours of a period. Every entry in the
   * period becomes a line item and is then linked firmly, so that none of it
   * can end up on a second invoice.
   */
  app.post('/from-time', { schema: { body: invoiceFromTimeInput } }, async (req, reply) => {
    const data = req.body
    return reply.code(201).send(await invoiceFromTime(data))
  })

  app.patch('/:id', { schema: { params: idParam, body: invoiceInput.partial() } }, async (req) =>
    updateInvoice(req.params.id, req.body),
  )

  app.post('/:id/status', { schema: { params: idParam, body: invoiceStatusInput } }, async (req) =>
    setInvoiceStatus(req.params.id, req.body.status),
  )

  app.get('/:id/pdf', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    const invoice = await invoiceForPdf(id)
    const pdf = await renderInvoicePdf(invoice)
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `inline; filename="${invoice.number}.pdf"`)
    return reply.send(pdf)
  })

  app.delete('/:id', { schema: { params: idParam } }, async (req, reply) => {
    const { id } = req.params
    await deleteInvoice(id)
    return reply.code(204).send()
  })
}

export default routes
