import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { get, post, tool } from '../client.js'

export function registerMoney(server: McpServer): void {
  tool(
    server,
    'soloops_unbilled_time',
    'Alle abrechenbaren, noch nicht fakturierten Zeiteinträge.',
    { clientId: z.string().optional(), projectId: z.string().optional() },
    (args) => get('/api/time', { ...args, unbilledOnly: true }),
  )

  tool(
    server,
    'soloops_list_invoices',
    'Rechnungsübersicht inklusive offener und bezahlter Summen.',
    { status: z.string().optional(), clientId: z.string().optional(), year: z.number().optional() },
    (args) => get('/api/invoices', args),
  )

  tool(
    server,
    'soloops_draft_invoice_from_time',
    'Erstellt einen Rechnungsentwurf aus den offenen Zeiten eines Kunden im Zeitraum. Der Entwurf wird NICHT versendet und nicht an die Buchhaltung übertragen.',
    {
      clientId: z.string(),
      projectId: z.string().optional(),
      from: z.string().describe('ISO-Datum'),
      to: z.string().describe('ISO-Datum'),
      groupByProject: z.boolean().default(true),
    },
    (args) => post('/api/invoices/from-time', args),
  )

  tool(
    server,
    'soloops_set_invoice_status',
    'Rechnungsstatus setzen — vor allem „PAID", wenn Geld eingegangen ist. Versand und Übertragung an die Buchhaltung bleiben Handarbeit.',
    {
      invoiceId: z.string(),
      status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']),
    },
    ({ invoiceId, status }) => post(`/api/invoices/${invoiceId}/status`, { status }),
  )

  tool(
    server,
    'soloops_revenue',
    'Umsatz pro Monat für ein Jahr (netto, USt, brutto) — Basis für Vorauszahlungen und USt-Voranmeldung.',
    { year: z.number().optional() },
    (args) => get('/api/accounting/revenue', args),
  )
}
