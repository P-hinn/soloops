import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { get, patch, post, tool } from '../client.js'

const status = z.enum(['LEAD', 'ACTIVE', 'PAUSED', 'DONE', 'ARCHIVED'])

const fields = {
  description: z.string().optional(),
  status: status.optional(),
  color: z.string().optional().describe('Hex, z.B. #6366f1'),
  clientId: z.string().optional(),
  hourlyRateCents: z.number().int().min(0).optional().describe('überschreibt den Kundensatz'),
  budgetCents: z.number().int().min(0).optional(),
  startsOn: z.string().optional().describe('ISO-8601 Zeitstempel'),
  dueOn: z.string().optional().describe('ISO-8601 Zeitstempel'),
}

export function registerProjects(server: McpServer): void {
  tool(
    server,
    'soloops_list_projects',
    'Alle Projekte mit Status, erfasster Zeit und nicht abgerechneten Stunden.',
    { status: status.optional() },
    (args) => get('/api/projects', args),
  )

  tool(
    server,
    'soloops_get_project',
    'Vollbild eines Projekts: Kunde, Zeiten, Monitore, Pipelines, Notizen, Meetings, offene Action Items, letzter AI-Lagebericht.',
    { projectId: z.string() },
    ({ projectId }) => get(`/api/projects/${projectId}`),
  )

  tool(
    server,
    'soloops_create_project',
    'Projekt anlegen. Der Key ist das Kürzel in Listen und Rechnungen (A-Z, 0-9, - und _, 2–24 Zeichen) und muss eindeutig sein.',
    {
      key: z
        .string()
        .min(2)
        .max(24)
        .regex(/^[A-Z0-9_-]+$/),
      name: z.string().min(1),
      ...fields,
    },
    (args) => post('/api/projects', args),
  )

  tool(
    server,
    'soloops_update_project',
    'Projekt ändern — nur die übergebenen Felder. Status `ARCHIVED` nimmt es aus dem Alltag, ohne etwas zu löschen.',
    {
      projectId: z.string(),
      key: z.string().min(2).max(24).optional(),
      name: z.string().min(1).optional(),
      ...fields,
    },
    ({ projectId, ...body }) => patch(`/api/projects/${projectId}`, body),
  )

  tool(
    server,
    'soloops_project_digest',
    'Erzeugt einen frischen AI-Lagebericht für ein Projekt (Status, nächste Schritte, Risiken, Abrechnungshinweis).',
    { projectId: z.string() },
    ({ projectId }) => post(`/api/projects/${projectId}/digest`),
  )
}
