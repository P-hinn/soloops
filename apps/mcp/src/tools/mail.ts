import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { get, patch, post, tool } from '../client.js'

export function registerMail(server: McpServer): void {
  tool(
    server,
    'soloops_inbox',
    'Gelesene Mails mit ihrer Zuordnung. `unassigned` zeigt, was das System nicht einordnen konnte und auf dich wartet.',
    {
      unassigned: z.boolean().optional(),
      category: z.enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER']).optional(),
      leadId: z.string().optional(),
      take: z.number().max(200).optional(),
    },
    (args) => get('/api/mail', args),
  )

  tool(
    server,
    'soloops_assign_mail',
    'Mail einem Lead, Kunden oder Projekt zuordnen. Eine Zuordnung von Hand wird später nie automatisch überschrieben.',
    {
      mailId: z.string(),
      leadId: z.string().nullable().optional(),
      clientId: z.string().nullable().optional(),
      projectId: z.string().nullable().optional(),
      category: z.enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER']).optional(),
      handled: z.boolean().optional(),
    },
    ({ mailId, ...body }) => patch(`/api/mail/${mailId}`, body),
  )

  tool(
    server,
    'soloops_lead_from_mail',
    'Legt aus einer Mail einen Lead an: Absender, Betreff und Firma werden übernommen, die Mail wird dem neuen Lead zugeordnet.',
    { mailId: z.string() },
    ({ mailId }) => post(`/api/mail/${mailId}/lead`),
  )
}
