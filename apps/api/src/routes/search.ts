import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'

type Hit = {
  type: 'note' | 'meeting' | 'transcript' | 'project' | 'client' | 'invoice'
  id: string
  title: string
  snippet: string
  url: string
}

/** Globale Suche über alle Module — auch das Rückgrat des MCP-Tools `search`. */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async (req) => {
    const q = z
      .object({ q: z.string().min(2), take: z.coerce.number().max(50).default(20) })
      .parse(req.query)
    const term = q.q

    const [notes, meetings, transcripts, projects, clients, invoices] = await Promise.all([
      prisma.$queryRaw<{ id: string; title: string; snippet: string }[]>`
        SELECT id, title,
               ts_headline('german', coalesce(body,''), websearch_to_tsquery('german', ${term}),
                           'MaxWords=25,MinWords=10,StartSel=«,StopSel=»') AS snippet
        FROM "Note"
        WHERE to_tsvector('german', coalesce(title,'') || ' ' || coalesce(body,''))
              @@ websearch_to_tsquery('german', ${term})
        ORDER BY "updatedAt" DESC LIMIT ${q.take}
      `,
      prisma.meeting.findMany({
        where: {
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { summary: { contains: term, mode: 'insensitive' } },
            { minutes: { contains: term, mode: 'insensitive' } },
          ],
        },
        take: q.take,
        orderBy: { startsAt: 'desc' },
      }),
      prisma.$queryRaw<{ id: string; meetingId: string; snippet: string }[]>`
        SELECT id, "meetingId",
               ts_headline('german', text, websearch_to_tsquery('german', ${term}),
                           'MaxWords=30,MinWords=12,StartSel=«,StopSel=»') AS snippet
        FROM "Transcript"
        WHERE to_tsvector('german', coalesce(text,'')) @@ websearch_to_tsquery('german', ${term})
        LIMIT ${q.take}
      `,
      prisma.project.findMany({
        where: {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { key: { contains: term, mode: 'insensitive' } },
            { description: { contains: term, mode: 'insensitive' } },
          ],
        },
        take: 10,
      }),
      prisma.client.findMany({
        where: {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { company: { contains: term, mode: 'insensitive' } },
          ],
        },
        take: 10,
      }),
      prisma.invoice.findMany({
        where: { number: { contains: term, mode: 'insensitive' } },
        take: 10,
        include: { client: { select: { name: true } } },
      }),
    ])

    const hits: Hit[] = [
      ...notes.map((n) => ({
        type: 'note' as const,
        id: n.id,
        title: n.title,
        snippet: n.snippet,
        url: `/notes/${n.id}`,
      })),
      ...meetings.map((m) => ({
        type: 'meeting' as const,
        id: m.id,
        title: m.title,
        snippet: (m.summary ?? m.minutes ?? '').slice(0, 200),
        url: `/meetings/${m.id}`,
      })),
      ...transcripts.map((t) => ({
        type: 'transcript' as const,
        id: t.id,
        title: 'Transkript',
        snippet: t.snippet,
        url: `/meetings/${t.meetingId}`,
      })),
      ...projects.map((p) => ({
        type: 'project' as const,
        id: p.id,
        title: `${p.key} — ${p.name}`,
        snippet: p.description?.slice(0, 200) ?? '',
        url: `/projects/${p.id}`,
      })),
      ...clients.map((c) => ({
        type: 'client' as const,
        id: c.id,
        title: c.company ? `${c.name} (${c.company})` : c.name,
        snippet: c.notes?.slice(0, 200) ?? '',
        url: `/clients/${c.id}`,
      })),
      ...invoices.map((i) => ({
        type: 'invoice' as const,
        id: i.id,
        title: `${i.number} — ${i.client.name}`,
        snippet: `${(i.totalCents / 100).toFixed(2)} ${i.currency} · ${i.status}`,
        url: `/invoices/${i.id}`,
      })),
    ]

    return { query: term, count: hits.length, hits }
  })
}

export default routes
