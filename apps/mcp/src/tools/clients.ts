import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { get, patch, post, tool } from '../client.js'

/** Everything about a client that may be set, all of it optional. */
const fields = {
  company: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  street: z.string().optional(),
  zip: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  vatId: z.string().optional(),
  hourlyRateCents: z.number().int().min(0).optional().describe('Stundensatz in Cent'),
  paymentTermDays: z.number().int().positive().optional(),
  notes: z.string().optional(),
}

export function registerClients(server: McpServer): void {
  tool(
    server,
    'soloops_list_clients',
    'Alle Kunden mit Anzahl Projekte und Rechnungen.',
    { includeArchived: z.boolean().optional() },
    (args) => get('/api/clients', args),
  )

  tool(
    server,
    'soloops_get_client',
    'Ein Kunde mit Projekten und den letzten Rechnungen.',
    { clientId: z.string() },
    ({ clientId }) => get(`/api/clients/${clientId}`),
  )

  tool(
    server,
    'soloops_create_client',
    'Kunden anlegen. Ohne Stundensatz gilt der Standardsatz aus der Konfiguration.',
    { name: z.string().min(1), ...fields },
    (args) => post('/api/clients', args),
  )

  tool(
    server,
    'soloops_update_client',
    'Kundendaten ändern — nur die übergebenen Felder werden angefasst. `archived: true` nimmt den Kunden aus den Listen.',
    {
      clientId: z.string(),
      name: z.string().min(1).optional(),
      ...fields,
      archived: z.boolean().optional(),
    },
    ({ clientId, ...body }) => patch(`/api/clients/${clientId}`, body),
  )
}
