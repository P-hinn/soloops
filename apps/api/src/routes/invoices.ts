import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { invoiceFromTimeInput, invoiceInput, secondsToBillableHours } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { renderInvoicePdf } from '../services/invoicePdf.js'

const idParam = z.object({ id: z.string() })

/** Sequential number per year: RE-2026-0001 */
async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear()
  const prefix = `${env.INVOICE_NUMBER_PREFIX}-${year}-`
  const last = await prisma.invoice.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  })
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1
  return `${prefix}${String(seq).padStart(4, '0')}`
}

type ItemDraft = {
  description: string
  quantity: number
  unit: string
  unitPriceCents: number
  timeEntryIds?: string[]
}

function totals(items: ItemDraft[], taxRate: number, smallBusiness: boolean) {
  const subtotalCents = items.reduce((sum, i) => sum + Math.round(i.quantity * i.unitPriceCents), 0)
  const effectiveRate = smallBusiness ? 0 : taxRate
  const taxCents = Math.round((subtotalCents * effectiveRate) / 100)
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents, effectiveRate }
}

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

    const where: Prisma.InvoiceWhereInput = {
      ...(q.status ? { status: q.status as never } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.year
        ? {
            issueDate: {
              gte: new Date(q.year, 0, 1),
              lt: new Date(q.year + 1, 0, 1),
            },
          }
        : {}),
    }

    const [invoices, open, paid] = await Promise.all([
      prisma.invoice.findMany({
        where,
        orderBy: { issueDate: 'desc' },
        include: {
          client: { select: { id: true, name: true, company: true } },
          project: { select: { id: true, key: true } },
        },
      }),
      prisma.invoice.aggregate({
        where: { status: { in: ['SENT', 'OVERDUE'] } },
        _sum: { totalCents: true },
      }),
      prisma.invoice.aggregate({ where: { status: 'PAID' }, _sum: { totalCents: true } }),
    ])

    return {
      invoices,
      openCents: open._sum.totalCents ?? 0,
      paidCents: paid._sum.totalCents ?? 0,
    }
  })

  app.get('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        client: true,
        project: true,
        items: { orderBy: { position: 'asc' }, include: { timeEntries: true } },
      },
    })
    if (!invoice) return reply.code(404).send({ error: 'Rechnung nicht gefunden' })
    return invoice
  })

  app.post('/', async (req, reply) => {
    const data = invoiceInput.parse(req.body)
    const client = await prisma.client.findUniqueOrThrow({ where: { id: data.clientId } })

    const smallBusiness = data.smallBusiness ?? env.INVOICE_SMALL_BUSINESS
    const taxRate = data.taxRate ?? env.INVOICE_DEFAULT_TAX_RATE
    const issueDate = data.issueDate ? new Date(data.issueDate) : new Date()
    const dueDate = data.dueDate
      ? new Date(data.dueDate)
      : new Date(issueDate.getTime() + client.paymentTermDays * 86_400_000)

    const sums = totals(data.items, taxRate, smallBusiness)

    const invoice = await prisma.invoice.create({
      data: {
        number: await nextInvoiceNumber(),
        clientId: data.clientId,
        projectId: data.projectId ?? null,
        issueDate,
        dueDate,
        currency: client.currency,
        taxRate: sums.effectiveRate,
        smallBusiness,
        subtotalCents: sums.subtotalCents,
        taxCents: sums.taxCents,
        totalCents: sums.totalCents,
        intro: data.intro ?? null,
        notes: data.notes ?? null,
        items: {
          create: data.items.map((item, index) => ({
            position: index + 1,
            description: item.description,
            quantity: new Prisma.Decimal(item.quantity),
            unit: item.unit,
            unitPriceCents: item.unitPriceCents,
            amountCents: Math.round(item.quantity * item.unitPriceCents),
          })),
        },
      },
      include: { items: true, client: true },
    })
    return reply.code(201).send(invoice)
  })

  /**
   * The actual lever: every unbilled, billable time entry of a client in the
   * period becomes a line item and is then linked firmly, so that none of it
   * can end up on a second invoice.
   */
  app.post('/from-time', async (req, reply) => {
    const data = invoiceFromTimeInput.parse(req.body)
    const client = await prisma.client.findUniqueOrThrow({ where: { id: data.clientId } })

    const entries = await prisma.timeEntry.findMany({
      where: {
        clientId: data.clientId,
        ...(data.projectId ? { projectId: data.projectId } : {}),
        billable: true,
        invoiceItemId: null,
        endedAt: { not: null, gte: new Date(data.from), lte: new Date(data.to) },
      },
      include: { project: { select: { id: true, key: true, name: true } } },
      orderBy: { startedAt: 'asc' },
    })

    if (entries.length === 0) {
      return reply.code(422).send({ error: 'Keine offenen abrechenbaren Zeiten im Zeitraum' })
    }

    const drafts: ItemDraft[] = []
    if (data.groupByProject) {
      const byProject = new Map<string, typeof entries>()
      for (const e of entries) {
        const list = byProject.get(e.projectId) ?? []
        list.push(e)
        byProject.set(e.projectId, list)
      }
      for (const [, list] of byProject) {
        const seconds = list.reduce((s, e) => s + e.durationSec, 0)
        const rate = list[0]?.rateCents ?? env.INVOICE_DEFAULT_HOURLY_RATE_CENTS
        const project = list[0]?.project
        const descriptions = [...new Set(list.map((e) => e.description).filter(Boolean))]
        drafts.push({
          description: [
            `${project?.name ?? 'Projekt'} (${project?.key ?? '-'})`,
            descriptions.length ? descriptions.map((d) => `• ${d}`).join('\n') : null,
          ]
            .filter(Boolean)
            .join('\n'),
          quantity: secondsToBillableHours(seconds),
          unit: 'Std.',
          unitPriceCents: rate,
          timeEntryIds: list.map((e) => e.id),
        })
      }
    } else {
      for (const e of entries) {
        drafts.push({
          description: `${e.project.key}: ${e.description || 'Leistung'} (${e.startedAt.toLocaleDateString('de-DE')})`,
          quantity: secondsToBillableHours(e.durationSec),
          unit: 'Std.',
          unitPriceCents: e.rateCents ?? env.INVOICE_DEFAULT_HOURLY_RATE_CENTS,
          timeEntryIds: [e.id],
        })
      }
    }

    const smallBusiness = env.INVOICE_SMALL_BUSINESS
    const sums = totals(drafts, env.INVOICE_DEFAULT_TAX_RATE, smallBusiness)
    const issueDate = new Date()
    const dueDate = new Date(issueDate.getTime() + client.paymentTermDays * 86_400_000)

    const invoice = await prisma.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: {
          number: await nextInvoiceNumber(),
          clientId: data.clientId,
          projectId: data.projectId ?? null,
          issueDate,
          dueDate,
          currency: client.currency,
          taxRate: sums.effectiveRate,
          smallBusiness,
          subtotalCents: sums.subtotalCents,
          taxCents: sums.taxCents,
          totalCents: sums.totalCents,
          intro: `Leistungszeitraum ${new Date(data.from).toLocaleDateString('de-DE')} – ${new Date(data.to).toLocaleDateString('de-DE')}`,
        },
      })

      for (const [index, draft] of drafts.entries()) {
        const item = await tx.invoiceItem.create({
          data: {
            invoiceId: created.id,
            position: index + 1,
            description: draft.description,
            quantity: new Prisma.Decimal(draft.quantity),
            unit: draft.unit,
            unitPriceCents: draft.unitPriceCents,
            amountCents: Math.round(draft.quantity * draft.unitPriceCents),
          },
        })
        if (draft.timeEntryIds?.length) {
          await tx.timeEntry.updateMany({
            where: { id: { in: draft.timeEntryIds } },
            data: { invoiceItemId: item.id },
          })
        }
      }

      return tx.invoice.findUniqueOrThrow({
        where: { id: created.id },
        include: { items: true, client: true },
      })
    })

    return reply.code(201).send(invoice)
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const current = await prisma.invoice.findUniqueOrThrow({ where: { id } })
    if (current.status !== 'DRAFT') {
      return reply.code(409).send({ error: 'Nur Entwürfe können bearbeitet werden' })
    }
    const data = invoiceInput.partial().parse(req.body)

    if (data.items) {
      const smallBusiness = data.smallBusiness ?? current.smallBusiness
      const sums = totals(data.items, data.taxRate ?? current.taxRate, smallBusiness)
      await prisma.$transaction(async (tx) => {
        // Release the linked time entries before the line items are replaced
        const items = await tx.invoiceItem.findMany({ where: { invoiceId: id } })
        await tx.timeEntry.updateMany({
          where: { invoiceItemId: { in: items.map((i) => i.id) } },
          data: { invoiceItemId: null },
        })
        await tx.invoiceItem.deleteMany({ where: { invoiceId: id } })
        await tx.invoice.update({
          where: { id },
          data: {
            intro: data.intro,
            notes: data.notes,
            taxRate: sums.effectiveRate,
            smallBusiness,
            subtotalCents: sums.subtotalCents,
            taxCents: sums.taxCents,
            totalCents: sums.totalCents,
            pdfPath: null,
            items: {
              create: data.items!.map((item, index) => ({
                position: index + 1,
                description: item.description,
                quantity: new Prisma.Decimal(item.quantity),
                unit: item.unit,
                unitPriceCents: item.unitPriceCents,
                amountCents: Math.round(item.quantity * item.unitPriceCents),
              })),
            },
          },
        })
      })
    } else {
      await prisma.invoice.update({
        where: { id },
        data: {
          intro: data.intro,
          notes: data.notes,
          dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
          projectId: data.projectId,
        },
      })
    }

    return prisma.invoice.findUniqueOrThrow({
      where: { id },
      include: { items: { orderBy: { position: 'asc' } }, client: true },
    })
  })

  app.post('/:id/status', async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z
      .object({ status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']) })
      .parse(req.body)
    return prisma.invoice.update({
      where: { id },
      data: {
        status: body.status,
        paidAt: body.status === 'PAID' ? new Date() : null,
      },
    })
  })

  app.get('/:id/pdf', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id },
      include: { client: true, project: true, items: { orderBy: { position: 'asc' } } },
    })
    const pdf = await renderInvoicePdf(invoice)
    reply.header('Content-Type', 'application/pdf')
    reply.header('Content-Disposition', `inline; filename="${invoice.number}.pdf"`)
    return reply.send(pdf)
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params)
    const invoice = await prisma.invoice.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    })
    if (invoice.status !== 'DRAFT') {
      return reply
        .code(409)
        .send({ error: 'Gestellte Rechnungen dürfen nicht gelöscht werden — bitte stornieren' })
    }
    await prisma.$transaction(async (tx) => {
      await tx.timeEntry.updateMany({
        where: { invoiceItemId: { in: invoice.items.map((i) => i.id) } },
        data: { invoiceItemId: null },
      })
      await tx.invoice.delete({ where: { id } })
    })
    return reply.code(204).send()
  })
}

export default routes
