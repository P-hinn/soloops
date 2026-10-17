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

/** The seven kinds that may be filed. Four of them soloops can also send. */
const contractType = z
  .enum([
    'nda',
    'werkvertrag',
    'dienstvertrag',
    'freie-mitarbeit',
    'rahmenvertrag',
    'avv',
    'sonstiges',
  ])
  .describe('Vertragsart')

/** Everything about a contract that may be set, all of it optional. */
const contractFields = {
  status: z
    .enum(['entwurf', 'versendet', 'signiert', 'abgelehnt', 'beendet'])
    .optional()
    .describe('Stand des Vertrags. Ein abgelaufener zeigt sich aus `endsOn`, nicht hier.'),
  projectId: z.string().optional().describe('Projekt, zu dem der Vertrag gehört'),
  signedOn: z.string().optional().describe('ISO-Zeitstempel der Unterschrift'),
  startsOn: z.string().optional().describe('ISO-Zeitstempel, ab wann er gilt'),
  endsOn: z.string().optional().describe('ISO-Zeitstempel, bis wann er läuft'),
  amountCents: z.number().int().min(0).optional().describe('Vertragswert in Cent'),
  notes: z.string().optional(),
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

  // --- the contracts filed at a client ---------------------------------------

  tool(
    server,
    'soloops_list_contracts',
    'Verträge. Ohne `clientId` die aller Kunden, mit `q` nach Titel, Notiz oder Kundenname gesucht. `status` filtert auf entwurf, versendet, signiert, abgelehnt oder beendet.',
    {
      clientId: z.string().optional(),
      projectId: z.string().optional(),
      status: z.string().optional(),
      q: z.string().optional(),
      includeArchived: z.boolean().optional(),
    },
    (args) => get('/api/contracts', args),
  )

  tool(
    server,
    'soloops_create_contract',
    'Vertrag beim Kunden ablegen — NDA, Werkvertrag, Dienstvertrag, freie Mitarbeit, Rahmenvertrag, AV-Vertrag oder sonstiges. Für einen Vertrag, der schon unterschrieben ist: `status: "signiert"` und `signedOn` setzen. Das PDF selbst wird in der App hochgeladen, nicht hier.',
    { clientId: z.string(), ...contractFields, type: contractType, title: z.string().min(1) },
    (args) => post('/api/contracts', args),
  )

  tool(
    server,
    'soloops_update_contract',
    'Vertrag ändern — nur die übergebenen Felder. `archived: true` nimmt ihn aus den Listen, ohne die Historie zu verlieren.',
    {
      contractId: z.string(),
      clientId: z.string().optional().describe('Zu diesem Kunden umhängen'),
      type: contractType.optional(),
      title: z.string().min(1).optional(),
      ...contractFields,
      archived: z.boolean().optional(),
    },
    ({ contractId, ...body }) => patch(`/api/contracts/${contractId}`, body),
  )

  tool(
    server,
    'soloops_delete_contract',
    'Vertrag löschen, samt hochgeladenem PDF. Wer die Historie behalten will, archiviert ihn über soloops_update_contract.',
    { contractId: z.string() },
    ({ contractId }) => del(`/api/contracts/${contractId}`),
  )

  // --- the files filed at a client -------------------------------------------
  //
  // Reading and tidying up, not uploading: the bytes come from a file picker
  // or a drop, and neither fits through a tool call. "Was liegt beim Kunden?"
  // and "benenn das um" do.

  tool(
    server,
    'soloops_list_attachments',
    'Dateien, die beim Kunden liegen — alles außer Verträgen. Ohne `clientId` die aller Kunden, mit `q` nach Name, Dateiname oder Notiz gesucht. Hochgeladen werden sie in der App.',
    {
      clientId: z.string().optional(),
      projectId: z.string().optional(),
      q: z.string().optional(),
    },
    (args) => get('/api/attachments', args),
  )

  tool(
    server,
    'soloops_update_attachment',
    'Datei umbenennen, einem Projekt zuordnen oder mit einer Notiz versehen — nur die übergebenen Felder. Die Datei selbst bleibt, wie sie hochgeladen wurde.',
    {
      attachmentId: z.string(),
      title: z.string().min(1).optional().describe('Name in soloops, z. B. "Briefing"'),
      projectId: z.string().optional().describe('Projekt, zu dem sie gehört'),
      notes: z.string().optional(),
    },
    ({ attachmentId, ...body }) => patch(`/api/attachments/${attachmentId}`, body),
  )

  tool(
    server,
    'soloops_delete_attachment',
    'Datei löschen, samt Inhalt aus der Ablage. Es gibt kein Archiv dafür: ohne die Datei sagt der Eintrag nichts.',
    { attachmentId: z.string() },
    ({ attachmentId }) => del(`/api/attachments/${attachmentId}`),
  )
}
