/**
 * The rules behind an invoice.
 *
 * Three invariants, and they are why this is not in the route: the number
 * series has no gaps and no duplicates (see nextInvoiceNumber), an invoice
 * that has left the house may not be edited or deleted, and no booked hour
 * may end up on two invoices.
 */
import { Prisma } from '@prisma/client'
import type { InvoiceStatus } from '@prisma/client'
import { secondsToBillableHours } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { conflict, invalid, notFound } from '../rules.js'

/** `RE-2026-0007` — fixed width, so the text sorts by number. */
export function invoiceNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`
}

/**
 * The next number for this year, inside the caller's transaction.
 *
 * The upsert takes a row lock on the year's counter, so a second request
 * waits here rather than reading the same maximum. That is the whole point:
 * reading `max(number)` and adding one is two statements, and two requests
 * that interleave them compute the same number. The unique index on
 * `Invoice.number` then turned the second invoice into a 409 with no retry.
 *
 * It has to be called with the `tx` of the same transaction that writes the
 * invoice. On the outer client it would commit by itself, and an invoice that
 * rolls back afterwards would leave a hole in the series — which is the one
 * thing a sequential number may not have.
 */
export async function nextInvoiceNumber(
  tx: Prisma.TransactionClient,
  prefix: string,
  year: number,
): Promise<string> {
  const counter = await tx.invoiceSequence.upsert({
    where: { year },
    create: { year, last: 1 },
    update: { last: { increment: 1 } },
    select: { last: true },
  })
  return invoiceNumber(prefix, year, counter.last)
}

// --- Line items and sums -----------------------------------------------------

export type ItemDraft = {
  description: string
  quantity: number
  unit: string
  unitPriceCents: number
  timeEntryIds?: string[]
}

/**
 * Subtotal, tax and total.
 *
 * Under the small-business rule the rate is zero no matter what was asked
 * for — §19 UStG is not a preference, and an invoice that shows tax under it
 * is wrong.
 */
export function totals(items: ItemDraft[], taxRate: number, smallBusiness: boolean) {
  const subtotalCents = items.reduce((sum, i) => sum + Math.round(i.quantity * i.unitPriceCents), 0)
  const effectiveRate = smallBusiness ? 0 : taxRate
  const taxCents = Math.round((subtotalCents * effectiveRate) / 100)
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents, effectiveRate }
}

function itemRows(items: ItemDraft[]) {
  return items.map((item, index) => ({
    position: index + 1,
    description: item.description,
    quantity: new Prisma.Decimal(item.quantity),
    unit: item.unit,
    unitPriceCents: item.unitPriceCents,
    amountCents: Math.round(item.quantity * item.unitPriceCents),
  }))
}

// --- Reading ------------------------------------------------------------------

export type InvoiceFilter = { status?: string; clientId?: string; year?: number }

export async function listInvoices(q: InvoiceFilter) {
  const where = {
    ...(q.status ? { status: q.status as InvoiceStatus } : {}),
    ...(q.clientId ? { clientId: q.clientId } : {}),
    ...(q.year
      ? { issueDate: { gte: new Date(q.year, 0, 1), lt: new Date(q.year + 1, 0, 1) } }
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
}

export async function getInvoice(id: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      client: true,
      project: true,
      items: { orderBy: { position: 'asc' }, include: { timeEntries: true } },
    },
  })
  if (!invoice) throw notFound('Rechnung nicht gefunden')
  return invoice
}

export function invoiceForPdf(id: string) {
  return prisma.invoice.findUniqueOrThrow({
    where: { id },
    include: { client: true, project: true, items: { orderBy: { position: 'asc' } } },
  })
}

// --- Writing ------------------------------------------------------------------

export type CreateInvoice = {
  clientId: string
  projectId?: string | null
  issueDate?: string | Date
  dueDate?: string | Date
  taxRate?: number
  smallBusiness?: boolean
  intro?: string | null
  notes?: string | null
  items: ItemDraft[]
}

export async function createInvoice(data: CreateInvoice) {
  const client = await prisma.client.findUniqueOrThrow({ where: { id: data.clientId } })

  const smallBusiness = data.smallBusiness ?? env.INVOICE_SMALL_BUSINESS
  const taxRate = data.taxRate ?? env.INVOICE_DEFAULT_TAX_RATE
  const issueDate = data.issueDate ? new Date(data.issueDate) : new Date()
  const dueDate = data.dueDate
    ? new Date(data.dueDate)
    : new Date(issueDate.getTime() + client.paymentTermDays * 86_400_000)

  const sums = totals(data.items, taxRate, smallBusiness)

  // A transaction, for the number's sake: it comes from the year's counter,
  // and counter and invoice have to be written together or a create that
  // fails would burn a number.
  return prisma.$transaction(async (tx) =>
    tx.invoice.create({
      data: {
        number: await nextInvoiceNumber(tx, env.INVOICE_NUMBER_PREFIX, issueDate.getFullYear()),
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
        items: { create: itemRows(data.items) },
      },
      include: { items: true, client: true },
    }),
  )
}

export type FromTime = {
  clientId: string
  projectId?: string | null
  from: string
  to: string
  groupByProject: boolean
}

/**
 * Draft an invoice out of the booked hours of a period.
 *
 * Every entry in the period becomes a line item and is then linked firmly,
 * so none of it can end up on a second invoice.
 */
export async function invoiceFromTime(data: FromTime) {
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
    throw invalid('Keine offenen abrechenbaren Zeiten im Zeitraum')
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
      // The typed text first, the commits of that window second: a line item
      // without a service description is a line item that gets asked about.
      const descriptions = [
        ...new Set(list.map((e) => e.description || e.autoSummary).filter(Boolean)),
      ]
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
        description: `${e.project.key}: ${e.description || e.autoSummary || 'Leistung'} (${e.startedAt.toLocaleDateString('de-DE')})`,
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

  return prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        number: await nextInvoiceNumber(tx, env.INVOICE_NUMBER_PREFIX, issueDate.getFullYear()),
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
}

export type UpdateInvoice = Partial<CreateInvoice>

/**
 * Change a draft.
 *
 * Only a draft: once an invoice has been issued its content is a document
 * that was sent, and correcting one is a cancellation plus a new invoice.
 */
export async function updateInvoice(id: string, data: UpdateInvoice) {
  const current = await prisma.invoice.findUniqueOrThrow({ where: { id } })
  if (current.status !== 'DRAFT') throw conflict('Nur Entwürfe können bearbeitet werden')

  // Named apart from the `items` read inside the transaction below: those are
  // the line items being replaced, these are the ones replacing them.
  const nextItems = data.items
  if (nextItems) {
    const smallBusiness = data.smallBusiness ?? current.smallBusiness
    const sums = totals(nextItems, data.taxRate ?? current.taxRate, smallBusiness)
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
          items: { create: itemRows(nextItems) },
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
}

export function setInvoiceStatus(id: string, status: InvoiceStatus) {
  return prisma.invoice.update({
    where: { id },
    data: { status, paidAt: status === 'PAID' ? new Date() : null },
  })
}

/**
 * Delete a draft, and give its hours back.
 *
 * An invoice that has been issued is not deleted but cancelled — it exists in
 * the client's books too, and a retention period runs on it.
 */
export async function deleteInvoice(id: string) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id },
    include: { items: true },
  })
  if (invoice.status !== 'DRAFT') {
    throw conflict('Gestellte Rechnungen dürfen nicht gelöscht werden — bitte stornieren')
  }
  await prisma.$transaction(async (tx) => {
    await tx.timeEntry.updateMany({
      where: { invoiceItemId: { in: invoice.items.map((i) => i.id) } },
      data: { invoiceItemId: null },
    })
    await tx.invoice.delete({ where: { id } })
  })
}
