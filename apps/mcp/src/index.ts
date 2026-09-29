#!/usr/bin/env -S npx tsx
/**
 * soloops MCP server (stdio).
 *
 * Gives Claude Code / Claude Desktop access to projects, time, notes,
 * meetings, operations and invoices. Authentication goes through the
 * SERVICE_TOKEN against the local REST API.
 *
 * Registering it in Claude Code:
 *   claude mcp add soloops -- npx tsx /path/to/soloops/apps/mcp/src/index.ts
 * with SOLOOPS_URL and SOLOOPS_TOKEN in the environment.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const BASE_URL = process.env.SOLOOPS_URL ?? 'http://localhost:3000'
const TOKEN = process.env.SOLOOPS_TOKEN ?? process.env.SERVICE_TOKEN

if (!TOKEN) {
  console.error('SOLOOPS_TOKEN (oder SERVICE_TOKEN) muss gesetzt sein.')
  process.exit(1)
}

async function api<T = unknown>(
  path: string,
  init: RequestInit & { query?: Record<string, unknown> } = {},
): Promise<T> {
  const url = new URL(path, BASE_URL)
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value))
  }
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: init.body,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`)
  return (text ? JSON.parse(text) : null) as T
}

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})
const fail = (err: unknown) => ({
  content: [{ type: 'text' as const, text: `Fehler: ${(err as Error).message}` }],
  isError: true,
})

const server = new McpServer({ name: 'soloops', version: '0.1.0' })

// ---------------------------------------------------------------------------
// Overview & search
// ---------------------------------------------------------------------------

server.tool(
  'soloops_today',
  'Tagesüberblick: heutige Termine, laufender Timer, offene Rechnungen, Störungen, fehlgeschlagene Pipelines, offene Action Items.',
  {},
  async () => {
    try {
      return ok(await api('/api/dashboard'))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_search',
  'Volltextsuche über Notizen, Meetings, Transkripte, Projekte, Kunden und Rechnungen.',
  { query: z.string().min(2).describe('Suchbegriff'), take: z.number().max(50).optional() },
  async ({ query, take }) => {
    try {
      return ok(await api('/api/search', { query: { q: query, take } }))
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

server.tool(
  'soloops_list_projects',
  'Alle Projekte mit Status, erfasster Zeit und nicht abgerechneten Stunden.',
  { status: z.enum(['LEAD', 'ACTIVE', 'PAUSED', 'DONE', 'ARCHIVED']).optional() },
  async ({ status }) => {
    try {
      return ok(await api('/api/projects', { query: { status } }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_get_project',
  'Vollbild eines Projekts: Kunde, Zeiten, Monitore, Pipelines, Notizen, Meetings, offene Action Items, letzter AI-Lagebericht.',
  { projectId: z.string() },
  async ({ projectId }) => {
    try {
      return ok(await api(`/api/projects/${projectId}`))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_project_digest',
  'Erzeugt einen frischen AI-Lagebericht für ein Projekt (Status, nächste Schritte, Risiken, Abrechnungshinweis).',
  { projectId: z.string() },
  async ({ projectId }) => {
    try {
      return ok(await api(`/api/projects/${projectId}/digest`, { method: 'POST' }))
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Time tracking
// ---------------------------------------------------------------------------

server.tool(
  'soloops_timer_status',
  'Zeigt den aktuell laufenden Timer (falls einer läuft).',
  {},
  async () => {
    try {
      return ok((await api('/api/time/running')) ?? { running: false })
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_timer_start',
  'Startet einen Timer auf ein Projekt. Ein bereits laufender Timer wird automatisch gestoppt.',
  {
    projectId: z.string(),
    description: z.string().default(''),
    billable: z.boolean().default(true),
  },
  async (args) => {
    try {
      return ok(
        await api('/api/time/start', {
          method: 'POST',
          body: JSON.stringify({ ...args, source: 'MCP' }),
        }),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool('soloops_timer_stop', 'Stoppt den laufenden Timer.', {}, async () => {
  try {
    return ok(await api('/api/time/stop', { method: 'POST', body: JSON.stringify({}) }))
  } catch (err) {
    return fail(err)
  }
})

server.tool(
  'soloops_log_time',
  'Trägt Zeit nachträglich ein (z.B. "gestern 2h Konzeption").',
  {
    projectId: z.string(),
    description: z.string(),
    startedAt: z.string().describe('ISO-8601 Zeitstempel'),
    endedAt: z.string().describe('ISO-8601 Zeitstempel'),
    billable: z.boolean().default(true),
  },
  async (args) => {
    try {
      return ok(await api('/api/time', { method: 'POST', body: JSON.stringify(args) }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_time_report',
  'Zeitauswertung für einen Zeitraum, gruppiert nach Projekt, inklusive Gegenwert in Euro.',
  {
    from: z.string().describe('ISO-Datum'),
    to: z.string().describe('ISO-Datum'),
    billableOnly: z.boolean().default(false),
  },
  async (args) => {
    try {
      return ok(await api('/api/time/report', { query: args }))
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Calendar & meetings
// ---------------------------------------------------------------------------

server.tool(
  'soloops_free_slots',
  'Findet freie Zeitfenster im Arbeitszeitfenster (Mo–Fr) — für Terminvorschläge an Kunden.',
  {
    days: z.number().min(1).max(60).default(10),
    minMinutes: z.number().min(15).default(60),
    dayStart: z.number().min(0).max(23).default(9),
    dayEnd: z.number().min(1).max(24).default(18),
  },
  async (args) => {
    try {
      return ok(await api('/api/calendar/free-slots', { query: args }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_create_event',
  'Legt einen Kalendereintrag an.',
  {
    title: z.string(),
    startsAt: z.string().describe('ISO-8601'),
    endsAt: z.string().describe('ISO-8601'),
    kind: z.enum(['FOCUS', 'MEETING', 'ADMIN', 'PERSONAL', 'TRAVEL']).default('FOCUS'),
    projectId: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
  },
  async (args) => {
    try {
      return ok(await api('/api/calendar', { method: 'POST', body: JSON.stringify(args) }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_list_meetings',
  'Listet Meetings inklusive Transkript-Status.',
  {
    projectId: z.string().optional(),
    from: z.string().optional(),
    take: z.number().max(100).optional(),
  },
  async (args) => {
    try {
      return ok(await api('/api/meetings', { query: args }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_get_meeting',
  'Ein Meeting im Detail: Agenda, Mitschrift, AI-Zusammenfassung, vollständiges Transkript, Action Items.',
  { meetingId: z.string() },
  async ({ meetingId }) => {
    try {
      return ok(await api(`/api/meetings/${meetingId}`))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_summarize_meeting',
  'Erzeugt aus Transkript oder Mitschrift eine Zusammenfassung, Entscheidungen und Action Items.',
  { meetingId: z.string() },
  async ({ meetingId }) => {
    try {
      return ok(await api(`/api/meetings/${meetingId}/summarize`, { method: 'POST' }))
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

server.tool(
  'soloops_create_note',
  'Legt eine Notiz an (Markdown), optional an ein Projekt gehängt.',
  {
    title: z.string(),
    body: z.string().default(''),
    tags: z.array(z.string()).default([]),
    projectId: z.string().optional(),
  },
  async (args) => {
    try {
      return ok(await api('/api/notes', { method: 'POST', body: JSON.stringify(args) }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_list_notes',
  'Listet oder durchsucht Notizen.',
  { projectId: z.string().optional(), tag: z.string().optional(), query: z.string().optional() },
  async ({ projectId, tag, query }) => {
    try {
      return ok(await api('/api/notes', { query: { projectId, tag, q: query } }))
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

server.tool(
  'soloops_ops_status',
  'Betriebsstatus: UptimeRobot-Monitore und die letzten CI/CD-Läufe.',
  {},
  async () => {
    try {
      const [uptime, pipelines] = await Promise.all([
        api('/api/uptime'),
        api('/api/pipelines/repos'),
      ])
      return ok({ uptime, pipelines })
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

server.tool(
  'soloops_unbilled_time',
  'Alle abrechenbaren, noch nicht fakturierten Zeiteinträge.',
  { clientId: z.string().optional(), projectId: z.string().optional() },
  async (args) => {
    try {
      return ok(await api('/api/time', { query: { ...args, unbilledOnly: true } }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_list_invoices',
  'Rechnungsübersicht inklusive offener und bezahlter Summen.',
  { status: z.string().optional(), clientId: z.string().optional(), year: z.number().optional() },
  async (args) => {
    try {
      return ok(await api('/api/invoices', { query: args }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_draft_invoice_from_time',
  'Erstellt einen Rechnungsentwurf aus den offenen Zeiten eines Kunden im Zeitraum. Der Entwurf wird NICHT versendet und nicht an die Buchhaltung übertragen.',
  {
    clientId: z.string(),
    projectId: z.string().optional(),
    from: z.string().describe('ISO-Datum'),
    to: z.string().describe('ISO-Datum'),
    groupByProject: z.boolean().default(true),
  },
  async (args) => {
    try {
      return ok(
        await api('/api/invoices/from-time', { method: 'POST', body: JSON.stringify(args) }),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_revenue',
  'Umsatz pro Monat für ein Jahr (netto, USt, brutto) — Basis für Vorauszahlungen und USt-Voranmeldung.',
  { year: z.number().optional() },
  async ({ year }) => {
    try {
      return ok(await api('/api/accounting/revenue', { query: { year } }))
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

server.tool(
  'soloops_pipeline',
  'Vertriebspipeline: offene Chancen, Volumen, gewichteter Forecast, Trefferquote und was zu lange stillliegt.',
  {},
  async () => {
    try {
      return ok(await api('/api/leads/pipeline'))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_list_leads',
  'Leads auflisten, optional nach Stufe oder nur die offenen. Enthält Wert, Wahrscheinlichkeit, AI-Score und Tage ohne Aktivität.',
  {
    stage: z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']).optional(),
    open: z.boolean().optional().describe('nur nicht entschiedene Leads'),
  },
  async ({ stage, open }) => {
    try {
      return ok(await api('/api/leads', { query: { stage, open } }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_get_lead',
  'Ein Lead mit Angeboten, Verlauf und zugeordneten Mails.',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/leads/${id}`))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_create_lead',
  'Neuen Lead anlegen. Die E-Mail-Adresse sorgt dafür, dass künftige Mails dieses Kontakts automatisch hier landen.',
  {
    title: z.string(),
    company: z.string().optional(),
    contactName: z.string().optional(),
    contactEmail: z.string().optional(),
    source: z.enum(['REFERRAL', 'WEBSITE', 'OUTBOUND', 'NETWORK', 'EVENT', 'OTHER']).optional(),
    valueCents: z.number().optional(),
    probability: z.number().min(0).max(100).optional(),
    notes: z.string().optional(),
  },
  async (args) => {
    try {
      return ok(await api('/api/leads', { method: 'POST', body: JSON.stringify(args) }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_log_offer',
  'Angebot an einem Lead erfassen: was wurde für wie viel angeboten. Ein verschicktes Angebot hebt die Stufe auf „Angebot".',
  {
    leadId: z.string(),
    title: z.string(),
    amountCents: z.number(),
    status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED']).optional(),
    scope: z.string().optional(),
    sentOn: z.string().optional().describe('ISO-Datum'),
    validUntil: z.string().optional(),
  },
  async ({ leadId, ...body }) => {
    try {
      return ok(
        await api(`/api/leads/${leadId}/offers`, { method: 'POST', body: JSON.stringify(body) }),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_log_lead_activity',
  'Kontakt am Lead protokollieren (Anruf, Mail, Meeting, Notiz). Setzt zugleich „zuletzt angefasst".',
  {
    leadId: z.string(),
    kind: z.enum(['NOTE', 'CALL', 'MAIL', 'MEETING']).optional(),
    body: z.string(),
    occurredAt: z.string().optional(),
  },
  async ({ leadId, ...body }) => {
    try {
      return ok(
        await api(`/api/leads/${leadId}/activities`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
  'soloops_set_lead_stage',
  'Lead auf eine andere Stufe setzen, mit Begründung im Verlauf.',
  {
    leadId: z.string(),
    stage: z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']),
    note: z.string().optional(),
  },
  async ({ leadId, ...body }) => {
    try {
      return ok(
        await api(`/api/leads/${leadId}/stage`, { method: 'POST', body: JSON.stringify(body) }),
      )
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

server.tool(
  'soloops_inbox',
  'Gelesene Mails mit ihrer Zuordnung. `unassigned` zeigt, was das System nicht einordnen konnte und auf dich wartet.',
  {
    unassigned: z.boolean().optional(),
    category: z.enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER']).optional(),
    leadId: z.string().optional(),
    take: z.number().max(200).optional(),
  },
  async (args) => {
    try {
      return ok(await api('/api/mail', { query: args }))
    } catch (err) {
      return fail(err)
    }
  },
)

server.tool(
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
  async ({ mailId, ...body }) => {
    try {
      return ok(await api(`/api/mail/${mailId}`, { method: 'PATCH', body: JSON.stringify(body) }))
    } catch (err) {
      return fail(err)
    }
  },
)

// ---------------------------------------------------------------------------

await server.connect(new StdioServerTransport())
console.error(`soloops MCP bereit (${BASE_URL})`)
