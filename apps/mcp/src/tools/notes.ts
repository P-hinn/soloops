import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { get, patch, post, tool } from '../client.js'

type Note = { id: string; body: string }

export function registerNotes(server: McpServer): void {
  tool(
    server,
    'soloops_list_notes',
    'Listet oder durchsucht Notizen.',
    {
      projectId: z.string().optional(),
      clientId: z.string().optional(),
      tag: z.string().optional(),
      query: z.string().optional(),
    },
    ({ query, ...rest }) => get('/api/notes', { ...rest, q: query }),
  )

  tool(
    server,
    'soloops_get_note',
    'Eine Notiz mit vollem Text und Zuordnung.',
    { noteId: z.string() },
    ({ noteId }) => get(`/api/notes/${noteId}`),
  )

  tool(
    server,
    'soloops_create_note',
    'Legt eine Notiz an (Markdown), optional an Projekt, Kunde oder Meeting gehängt.',
    {
      title: z.string(),
      body: z.string().default(''),
      tags: z.array(z.string()).default([]),
      pinned: z.boolean().optional(),
      projectId: z.string().optional(),
      clientId: z.string().optional(),
      meetingId: z.string().optional(),
    },
    (args) => post('/api/notes', args),
  )

  tool(
    server,
    'soloops_update_note',
    'Notiz ändern. `append` hängt einen Absatz an den bestehenden Text an, ohne ihn zu überschreiben — der normale Weg, während der Arbeit mitzuschreiben.',
    {
      noteId: z.string(),
      title: z.string().optional(),
      body: z.string().optional().describe('ersetzt den Text komplett'),
      append: z.string().optional().describe('wird mit Leerzeile angehängt'),
      tags: z.array(z.string()).optional(),
      pinned: z.boolean().optional(),
      projectId: z.string().optional(),
    },
    async ({ noteId, append, body, ...rest }) => {
      let next = body
      if (append !== undefined) {
        const current = await get<Note>(`/api/notes/${noteId}`)
        const base = body ?? current.body ?? ''
        next = base ? `${base.replace(/\s+$/, '')}\n\n${append}` : append
      }
      return patch(`/api/notes/${noteId}`, { ...rest, body: next })
    },
  )
}
