import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { get, tool } from '../client.js'

/** The entry points: what is going on, and finding things again. */
export function registerOverview(server: McpServer): void {
  tool(
    server,
    'soloops_today',
    'Tagesüberblick: heutige Termine, laufender Timer, offene Rechnungen, Störungen, fehlgeschlagene Pipelines, offene Action Items.',
    {},
    () => get('/api/dashboard'),
  )

  tool(
    server,
    'soloops_search',
    'Volltextsuche über Notizen, Meetings, Transkripte, Projekte, Kunden und Rechnungen.',
    { query: z.string().min(2).describe('Suchbegriff'), take: z.number().max(50).optional() },
    ({ query, take }) => get('/api/search', { q: query, take }),
  )

  tool(
    server,
    'soloops_activity_day',
    'Was an einem Tag auf dem Mac lief: Abschnitte je App, aktive und untätige Zeit. Hilft beim Nachtragen vergessener Zeiten.',
    {
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('YYYY-MM-DD, Standard heute'),
    },
    ({ date }) => get('/api/activity/day', { date }),
  )

  tool(
    server,
    'soloops_ops_status',
    'Betriebsstatus: UptimeRobot-Monitore und die letzten CI/CD-Läufe.',
    {},
    async () => {
      const [uptime, pipelines] = await Promise.all([
        get('/api/uptime'),
        get('/api/pipelines/repos'),
      ])
      return { uptime, pipelines }
    },
  )
}
