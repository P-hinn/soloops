import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { del, get, patch, post, tool } from '../client.js'

const stage = z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'])
const source = z.enum(['REFERRAL', 'WEBSITE', 'OUTBOUND', 'NETWORK', 'EVENT', 'OTHER'])
const offerStatus = z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'])

const fields = {
  company: z.string().optional(),
  contactName: z.string().optional(),
  contactEmail: z
    .string()
    .optional()
    .describe('ordnet künftige Mails dieses Kontakts automatisch zu'),
  phone: z.string().optional(),
  source: source.optional(),
  valueCents: z.number().int().min(0).optional().describe('erwartetes Volumen in Cent'),
  probability: z.number().min(0).max(100).optional().describe('eigene Einschätzung in Prozent'),
  expectedCloseOn: z.string().optional().describe('ISO-Datum'),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
  notes: z.string().optional(),
  followUpOn: z.string().optional().describe('ISO-Datum der Wiedervorlage'),
  followUpNote: z.string().optional().describe('worum es bei der Wiedervorlage geht'),
}

const offerFields = {
  status: offerStatus.optional(),
  currency: z.string().optional(),
  taxRate: z.number().optional(),
  scope: z.string().optional().describe('was enthalten ist'),
  number: z.string().optional(),
  sentOn: z.string().optional().describe('ISO-Datum'),
  validUntil: z.string().optional().describe('ISO-Datum'),
  notes: z.string().optional(),
}

export function registerLeads(server: McpServer): void {
  tool(
    server,
    'soloops_pipeline',
    'Vertriebspipeline: offene Chancen, Volumen, gewichteter Forecast, Trefferquote und was zu lange stillliegt.',
    {},
    () => get('/api/leads/pipeline'),
  )

  tool(
    server,
    'soloops_list_leads',
    'Leads auflisten, optional nach Stufe oder nur die offenen. Enthält Wert, Wahrscheinlichkeit, AI-Score und Tage ohne Aktivität.',
    {
      stage: stage.optional(),
      open: z.boolean().optional().describe('nur nicht entschiedene Leads'),
    },
    (args) => get('/api/leads', args),
  )

  tool(
    server,
    'soloops_get_lead',
    'Ein Lead mit Angeboten, Verlauf und zugeordneten Mails.',
    { leadId: z.string() },
    ({ leadId }) => get(`/api/leads/${leadId}`),
  )

  tool(
    server,
    'soloops_create_lead',
    'Neuen Lead anlegen. Die E-Mail-Adresse sorgt dafür, dass künftige Mails dieses Kontakts automatisch hier landen.',
    { title: z.string(), stage: stage.optional(), ...fields },
    (args) => post('/api/leads', args),
  )

  tool(
    server,
    'soloops_update_lead',
    'Lead-Felder ändern — Kontaktdaten, Volumen, Wahrscheinlichkeit, Notizen. Für den Stufenwechsel soloops_set_lead_stage nehmen, das schreibt den Verlauf mit.',
    { leadId: z.string(), title: z.string().optional(), ...fields },
    ({ leadId, ...body }) => patch(`/api/leads/${leadId}`, body),
  )

  tool(
    server,
    'soloops_set_lead_stage',
    'Lead auf eine andere Stufe setzen, mit Begründung im Verlauf. Bei LOST gehört der Grund in die Notiz.',
    { leadId: z.string(), stage, note: z.string().optional() },
    ({ leadId, ...body }) => post(`/api/leads/${leadId}/stage`, body),
  )

  tool(
    server,
    'soloops_archive_lead',
    'Lead archivieren — verschwindet aus Listen und Pipeline, bleibt aber mit seinem Verlauf erhalten. Für Fehleinträge und Dubletten.',
    { leadId: z.string() },
    ({ leadId }) => del(`/api/leads/${leadId}`),
  )

  tool(
    server,
    'soloops_due_follow_ups',
    'Wiedervorlagen: was heute oder überfällig dran ist, dazu das, was in den nächsten Tagen ansteht. Negative Tage heißen überfällig.',
    {
      withinDays: z.number().min(0).max(365).optional().describe('Vorschau nach vorn, Standard 14'),
    },
    (args) => get('/api/leads/follow-ups', args),
  )

  tool(
    server,
    'soloops_set_follow_up',
    'Lead auf Wiedervorlage packen oder die Wiedervorlage verschieben. Das Datum setzt die „zuletzt angefasst"-Uhr nicht zurück — eine Erinnerung ist kein Kundenkontakt.',
    {
      leadId: z.string(),
      on: z.string().describe('ISO-Datum, z.B. 2026-10-08'),
      note: z.string().optional().describe('was zu tun ist, z.B. „Angebot nachfassen"'),
    },
    ({ leadId, ...body }) => post(`/api/leads/${leadId}/follow-up`, body),
  )

  tool(
    server,
    'soloops_complete_follow_up',
    'Wiedervorlage abhaken: schreibt „nachgefasst" in den Verlauf, zählt als Kontakt und nimmt das Datum weg. Für einen Fehleintrag stattdessen soloops_clear_follow_up.',
    { leadId: z.string(), note: z.string().optional().describe('was dabei herauskam') },
    ({ leadId, ...body }) => post(`/api/leads/${leadId}/follow-up/done`, body),
  )

  tool(
    server,
    'soloops_clear_follow_up',
    'Wiedervorlage entfernen, ohne etwas in den Verlauf zu schreiben — für ein falsch gesetztes Datum.',
    { leadId: z.string() },
    ({ leadId }) => del(`/api/leads/${leadId}/follow-up`),
  )

  tool(
    server,
    'soloops_log_lead_activity',
    'Kontakt am Lead protokollieren (Anruf, Mail, Meeting, Notiz). Setzt zugleich „zuletzt angefasst".',
    {
      leadId: z.string(),
      kind: z.enum(['NOTE', 'CALL', 'MAIL', 'MEETING']).optional(),
      body: z.string(),
      occurredAt: z.string().optional().describe('ISO-8601, Standard jetzt'),
    },
    ({ leadId, ...body }) => post(`/api/leads/${leadId}/activities`, body),
  )

  tool(
    server,
    'soloops_log_offer',
    'Angebot an einem Lead erfassen: was wurde für wie viel angeboten. Ein verschicktes Angebot hebt die Stufe auf „Angebot".',
    { leadId: z.string(), title: z.string(), amountCents: z.number(), ...offerFields },
    ({ leadId, ...body }) => post(`/api/leads/${leadId}/offers`, body),
  )

  tool(
    server,
    'soloops_update_offer',
    'Angebot nachziehen. Status ACCEPTED setzt den Lead auf gewonnen, REJECTED schreibt die Ablehnung in den Verlauf.',
    {
      leadId: z.string(),
      offerId: z.string(),
      title: z.string().optional(),
      amountCents: z.number().optional(),
      ...offerFields,
    },
    ({ leadId, offerId, ...body }) => patch(`/api/leads/${leadId}/offers/${offerId}`, body),
  )

  tool(
    server,
    'soloops_score_lead',
    'AI-Bewertung eines Leads: Score, Begründung und vorgeschlagener nächster Schritt. Die eigene Wahrscheinlichkeit bleibt unangetastet.',
    { leadId: z.string() },
    ({ leadId }) => post(`/api/leads/${leadId}/score`),
  )
}
