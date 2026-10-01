import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { del, get, patch, post, tool } from '../client.js'

/** Action items — the open points from meetings and projects. */
export function registerTasks(server: McpServer): void {
  tool(
    server,
    'soloops_list_tasks',
    'Offene Action Items, optional nach Projekt oder Meeting. `open: false` zeigt auch die erledigten.',
    {
      open: z.boolean().optional().describe('Standard true'),
      projectId: z.string().optional(),
      meetingId: z.string().optional(),
      take: z.number().max(200).optional(),
    },
    (args) => get('/api/action-items', args),
  )

  tool(
    server,
    'soloops_create_task',
    'Action Item anlegen, optional an Projekt oder Meeting gehängt. Ohne Projekt landet es in der Tagesübersicht.',
    {
      title: z.string().min(1),
      dueOn: z.string().optional().describe('ISO-Datum'),
      assignee: z.string().optional(),
      projectId: z.string().optional(),
      meetingId: z.string().optional(),
    },
    (args) => post('/api/action-items', { ...args, source: 'MCP' }),
  )

  tool(
    server,
    'soloops_update_task',
    'Action Item ändern: Titel, Fälligkeit, Zuständigkeit, erledigt ja/nein.',
    {
      taskId: z.string(),
      title: z.string().min(1).optional(),
      done: z.boolean().optional(),
      dueOn: z.string().optional().describe('ISO-Datum'),
      assignee: z.string().optional(),
      projectId: z.string().optional(),
    },
    ({ taskId, ...body }) => patch(`/api/action-items/${taskId}`, body),
  )

  tool(
    server,
    'soloops_complete_task',
    'Action Item abhaken.',
    { taskId: z.string() },
    ({ taskId }) => patch(`/api/action-items/${taskId}`, { done: true }),
  )

  tool(
    server,
    'soloops_delete_task',
    'Action Item löschen — für falsch angelegte Punkte. Erledigtes besser abhaken statt löschen.',
    { taskId: z.string() },
    ({ taskId }) => del(`/api/action-items/${taskId}`),
  )
}
