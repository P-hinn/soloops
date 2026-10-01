import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { del, get, patch, post, tool } from '../client.js'

const kind = z.enum(['FOCUS', 'MEETING', 'ADMIN', 'PERSONAL', 'TRAVEL'])

const fields = {
  kind: kind.optional(),
  allDay: z.boolean().optional(),
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  withVideo: z.boolean().optional().describe('true legt einen Videoraum an, false entfernt ihn'),
}

export function registerCalendar(server: McpServer): void {
  tool(
    server,
    'soloops_free_slots',
    'Findet freie Zeitfenster im Arbeitszeitfenster (Mo–Fr) — für Terminvorschläge an Kunden. Berücksichtigt auch die verbundenen Fremdkalender.',
    {
      from: z.string().optional().describe('ISO-8601, Standard jetzt'),
      days: z.number().min(1).max(60).default(10),
      minMinutes: z.number().min(15).default(60),
      dayStart: z.number().min(0).max(23).default(9),
      dayEnd: z.number().min(1).max(24).default(18),
    },
    (args) => get('/api/calendar/free-slots', args),
  )

  tool(
    server,
    'soloops_list_events',
    'Termine in einem Zeitraum, inklusive der Einträge aus verbundenen Kalendern. Standard: diese Woche plus vier Wochen.',
    {
      from: z.string().optional().describe('ISO-8601'),
      to: z.string().optional().describe('ISO-8601'),
      projectId: z.string().optional(),
    },
    (args) => get('/api/calendar', args),
  )

  tool(
    server,
    'soloops_create_event',
    'Termin anlegen. Vorher mit soloops_list_events oder soloops_free_slots prüfen, ob die Zeit frei ist.',
    {
      title: z.string(),
      startsAt: z.string().describe('ISO-8601'),
      endsAt: z.string().describe('ISO-8601'),
      ...fields,
    },
    (args) => post('/api/calendar', args),
  )

  tool(
    server,
    'soloops_update_event',
    'Termin verschieben oder ändern — nur die übergebenen Felder. Einträge aus Fremdkalendern sind gesperrt und müssen dort bearbeitet werden.',
    {
      eventId: z.string(),
      title: z.string().optional(),
      startsAt: z.string().optional().describe('ISO-8601'),
      endsAt: z.string().optional().describe('ISO-8601'),
      ...fields,
    },
    ({ eventId, ...body }) => patch(`/api/calendar/${eventId}`, body),
  )

  tool(
    server,
    'soloops_delete_event',
    'Termin absagen. Wird auch in den verbundenen Kalendern entfernt.',
    { eventId: z.string() },
    ({ eventId }) => del(`/api/calendar/${eventId}`),
  )
}
