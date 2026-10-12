import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { del, get, patch, post, tool } from '../client.js'

const status = z
  .enum(['TODO', 'DOING', 'BLOCKED'])
  .describe('Board-Spalte: TODO (Backlog), DOING (in Arbeit), BLOCKED (blockiert)')

/**
 * Tasks — the to-do list, its board and what hangs off a ticket.
 *
 * A lead's follow-up carries one of these for itself: putting a lead on
 * follow-up creates the ticket, chasing it up closes it, and ticking the
 * ticket off here chases it up. Those carry `source: "LEAD"` — leave them to
 * the follow-up rather than deleting them by hand.
 */
export function registerTasks(server: McpServer): void {
  tool(
    server,
    'soloops_list_tasks',
    'Aufgaben, optional nach Spalte, Projekt, Kunde oder Meeting. `open: false` zeigt auch die erledigten. ' +
      'Jede Aufgabe bringt erfasste Zeit und verknüpfte Commits/PRs mit.',
    {
      open: z.boolean().optional().describe('Standard true'),
      status: status.optional(),
      projectId: z.string().optional(),
      clientId: z.string().optional(),
      meetingId: z.string().optional(),
      leadId: z.string().optional(),
      overdue: z.boolean().optional().describe('nur was über die Fälligkeit ist'),
      q: z.string().optional().describe('Titelsuche'),
      take: z.number().max(500).optional(),
    },
    (args) => get('/api/action-items', args),
  )

  tool(
    server,
    'soloops_get_task',
    'Eine Aufgabe mit allem: Fälligkeit, Projekt/Kunde, Links und den Zeiteinträgen darauf.',
    { taskId: z.string() },
    ({ taskId }) => get(`/api/action-items/${taskId}`),
  )

  tool(
    server,
    'soloops_create_task',
    'Aufgabe anlegen, optional an Projekt, Kunde oder Meeting gehängt. Ohne Projekt landet sie in der Tagesübersicht. ' +
      'Der Kunde kommt vom Projekt, wenn keiner genannt wird.',
    {
      title: z.string().min(1),
      dueOn: z.string().optional().describe('ISO-Datum'),
      status: status.optional().describe('Standard TODO'),
      assignee: z.string().optional(),
      projectId: z.string().optional(),
      clientId: z.string().optional(),
      meetingId: z.string().optional(),
      leadId: z
        .string()
        .optional()
        .describe('Aufgabe an einem Lead — Projekt und Kunde kommen von dort'),
    },
    (args) => post('/api/action-items', { ...args, source: 'MCP' }),
  )

  tool(
    server,
    'soloops_update_task',
    'Aufgabe ändern: Titel, Fälligkeit, Spalte, Projekt/Kunde, Zuständigkeit, erledigt ja/nein.',
    {
      taskId: z.string(),
      title: z.string().min(1).optional(),
      done: z.boolean().optional(),
      status: status.optional(),
      dueOn: z.string().optional().describe('ISO-Datum'),
      assignee: z.string().optional(),
      projectId: z.string().optional(),
      clientId: z.string().optional(),
      leadId: z.string().optional(),
    },
    ({ taskId, ...body }) => patch(`/api/action-items/${taskId}`, body),
  )

  tool(server, 'soloops_complete_task', 'Aufgabe abhaken.', { taskId: z.string() }, ({ taskId }) =>
    patch(`/api/action-items/${taskId}`, { done: true }),
  )

  tool(
    server,
    'soloops_link_task_commit',
    'Commit, Pull Request oder Issue an eine Aufgabe hängen. Nimmt die URL aus dem Browser ' +
      '(github.com/owner/repo/pull/12, .../commit/abc123) oder die Kurzform owner/repo#12 bzw. owner/repo@abc123. ' +
      'Titel und Status werden beim Anhängen gelesen, sofern ein Token für den Host konfiguriert ist.',
    { taskId: z.string(), url: z.string().describe('URL oder Kurzform') },
    ({ taskId, url }) => post(`/api/action-items/${taskId}/links`, { url }),
  )

  tool(
    server,
    'soloops_refresh_task_links',
    'Status aller Links einer Aufgabe neu lesen — ob der PR inzwischen gemerged ist.',
    { taskId: z.string() },
    ({ taskId }) => post(`/api/action-items/${taskId}/links/refresh`),
  )

  tool(
    server,
    'soloops_delete_task',
    'Aufgabe löschen — für falsch angelegte Punkte. Erledigtes besser abhaken statt löschen.',
    { taskId: z.string() },
    ({ taskId }) => del(`/api/action-items/${taskId}`),
  )
}
