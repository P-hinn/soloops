import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { del, get, patch, post, tool } from '../client.js'

/** Everything about a person at a client that may be set. */
const contactFields = {
  role: z.string().optional().describe('Funktion, z. B. "Geschäftsführung" oder "Buchhaltung"'),
  email: z.string().optional(),
  phone: z.string().optional(),
  notes: z.string().optional(),
  primary: z
    .boolean()
    .optional()
    .describe('Hauptansprechpartner. Setzt die Markierung bei den anderen des Kunden zurück.'),
}

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
    'Ein Kunde mit Ansprechpartnern, Projekten und den letzten Rechnungen.',
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

  // --- the people at a client ------------------------------------------------

  tool(
    server,
    'soloops_list_contacts',
    'Ansprechpartner. Ohne `clientId` die von allen Kunden, mit `q` nach Name, E-Mail oder Funktion gesucht. Hauptansprechpartner stehen vorn.',
    {
      clientId: z.string().optional(),
      q: z.string().optional(),
      includeArchived: z.boolean().optional(),
    },
    (args) => get('/api/contacts', args),
  )

  tool(
    server,
    'soloops_create_contact',
    'Ansprechpartner bei einem Kunden anlegen. Ein Kunde darf beliebig viele haben.',
    { clientId: z.string(), name: z.string().min(1), ...contactFields },
    (args) => post('/api/contacts', args),
  )

  tool(
    server,
    'soloops_update_contact',
    'Ansprechpartner ändern — nur die übergebenen Felder. Ein neues `clientId` hängt die Person zu einem anderen Kunden um; `archived: true` nimmt sie aus den Listen, ohne die Historie zu verlieren.',
    {
      contactId: z.string(),
      name: z.string().min(1).optional(),
      clientId: z.string().optional().describe('Zu diesem Kunden umhängen'),
      ...contactFields,
      archived: z.boolean().optional(),
    },
    ({ contactId, ...body }) => patch(`/api/contacts/${contactId}`, body),
  )

  tool(
    server,
    'soloops_delete_contact',
    'Ansprechpartner löschen. Wer noch gebraucht werden könnte, wird besser archiviert — siehe soloops_update_contact.',
    { contactId: z.string() },
    ({ contactId }) => del(`/api/contacts/${contactId}`),
  )
}
