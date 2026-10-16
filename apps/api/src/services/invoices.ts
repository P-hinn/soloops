/**
 * The rules behind an invoice. For now: its number.
 *
 * The number is the part that may not be wrong. German invoicing wants a
 * gapless series per year, which means two things that the old
 * `max(number) + 1` could not deliver: no number twice, and no number burned
 * on a request that fails.
 */
import type { Prisma } from '@prisma/client'

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
