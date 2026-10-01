import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { get, patch, post, tool } from '../client.js'

const fields = {
  status: z.enum(['PLANNED', 'RUNNING', 'DONE']).optional(),
  participants: z.array(z.string()).optional().describe('Namen oder Mailadressen'),
  agenda: z.string().optional(),
  minutes: z.string().optional().describe('Mitschrift, Markdown'),
  projectId: z.string().optional(),
  clientId: z.string().optional(),
}

export function registerMeetings(server: McpServer): void {
  tool(
    server,
    'soloops_list_meetings',
    'Listet Meetings inklusive Transkript-Status.',
    {
      projectId: z.string().optional(),
      from: z.string().optional(),
      take: z.number().max(100).optional(),
    },
    (args) => get('/api/meetings', args),
  )

  tool(
    server,
    'soloops_get_meeting',
    'Ein Meeting im Detail: Agenda, Mitschrift, AI-Zusammenfassung, vollständiges Transkript, Action Items.',
    { meetingId: z.string() },
    ({ meetingId }) => get(`/api/meetings/${meetingId}`),
  )

  tool(
    server,
    'soloops_create_meeting',
    'Meeting anlegen. Legt standardmäßig gleich den Kalendereintrag mit an; `withVideo` erzeugt dazu einen Videoraum.',
    {
      title: z.string(),
      startsAt: z.string().describe('ISO-8601'),
      endsAt: z.string().optional().describe('ISO-8601, Standard eine Stunde'),
      createEvent: z.boolean().optional().describe('Standard true'),
      withVideo: z.boolean().optional(),
      ...fields,
    },
    (args) => post('/api/meetings', args),
  )

  tool(
    server,
    'soloops_update_meeting',
    'Meeting ändern — Zeit, Teilnehmer, Agenda, Mitschrift. Ein verknüpfter Kalendereintrag zieht bei Titel und Zeit mit.',
    {
      meetingId: z.string(),
      title: z.string().optional(),
      startsAt: z.string().optional().describe('ISO-8601'),
      endsAt: z.string().optional().describe('ISO-8601'),
      ...fields,
    },
    ({ meetingId, ...body }) => patch(`/api/meetings/${meetingId}`, body),
  )

  tool(
    server,
    'soloops_summarize_meeting',
    'Erzeugt aus Transkript oder Mitschrift eine Zusammenfassung, Entscheidungen und Action Items.',
    { meetingId: z.string() },
    ({ meetingId }) => post(`/api/meetings/${meetingId}/summarize`),
  )
}
