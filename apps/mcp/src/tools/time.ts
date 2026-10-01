import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { del, get, patch, post, tool } from '../client.js'

export function registerTime(server: McpServer): void {
  tool(
    server,
    'soloops_timer_status',
    'Zeigt den aktuell laufenden Timer (falls einer läuft).',
    {},
    async () => (await get('/api/time/running')) ?? { running: false },
  )

  tool(
    server,
    'soloops_timer_start',
    'Startet einen Timer auf ein Projekt. Ein bereits laufender Timer wird automatisch gestoppt.',
    {
      projectId: z.string(),
      description: z.string().default(''),
      billable: z.boolean().default(true),
    },
    (args) => post('/api/time/start', { ...args, source: 'MCP' }),
  )

  tool(server, 'soloops_timer_stop', 'Stoppt den laufenden Timer.', {}, () =>
    post('/api/time/stop'),
  )

  tool(
    server,
    'soloops_log_time',
    'Trägt Zeit nachträglich ein (z.B. „gestern 2h Konzeption").',
    {
      projectId: z.string(),
      description: z.string(),
      startedAt: z.string().describe('ISO-8601 Zeitstempel'),
      endedAt: z.string().describe('ISO-8601 Zeitstempel'),
      billable: z.boolean().default(true),
      tags: z.array(z.string()).optional(),
    },
    (args) => post('/api/time', args),
  )

  tool(
    server,
    'soloops_update_time',
    'Zeiteintrag korrigieren: Beschreibung, Zeitraum, Projekt, abrechenbar ja/nein. Die Dauer wird neu gerechnet.',
    {
      timeEntryId: z.string(),
      description: z.string().optional(),
      startedAt: z.string().optional().describe('ISO-8601'),
      endedAt: z.string().optional().describe('ISO-8601'),
      projectId: z.string().optional(),
      billable: z.boolean().optional(),
      tags: z.array(z.string()).optional(),
    },
    ({ timeEntryId, ...body }) => patch(`/api/time/${timeEntryId}`, body),
  )

  tool(
    server,
    'soloops_delete_time',
    'Zeiteintrag löschen. Abgerechnete Einträge bleiben stehen — die hängen an einer Rechnung.',
    { timeEntryId: z.string() },
    ({ timeEntryId }) => del(`/api/time/${timeEntryId}`),
  )

  tool(
    server,
    'soloops_time_report',
    'Zeitauswertung für einen Zeitraum, gruppiert nach Projekt, inklusive Gegenwert in Euro.',
    {
      from: z.string().describe('ISO-Datum'),
      to: z.string().describe('ISO-Datum'),
      billableOnly: z.boolean().default(false),
    },
    (args) => get('/api/time/report', args),
  )
}
