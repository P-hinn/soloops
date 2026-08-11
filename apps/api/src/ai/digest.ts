// Der Anthropic-Zod-Helper erwartet Zod 4 — zod 3.25 liefert es unter /v4 mit.
import { z } from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { prisma } from '../db.js'
import { anthropic, MODEL } from './anthropic.js'
import { formatDuration } from '@soloops/shared'

// ---------------------------------------------------------------------------
// Schemas — Structured Outputs erzwingen ein Format, das die UI direkt rendert
// ---------------------------------------------------------------------------

const projectDigestSchema = z.object({
  headline: z.string().describe('Ein Satz: Wo steht das Projekt gerade?'),
  health: z.enum(['on_track', 'at_risk', 'blocked']),
  summary: z.string().describe('3-6 Sätze Fließtext, Deutsch, ohne Floskeln'),
  nextActions: z
    .array(
      z.object({
        title: z.string(),
        why: z.string(),
        urgency: z.enum(['today', 'this_week', 'later']),
      }),
    )
    .max(5),
  risks: z.array(z.string()).max(4),
  billingNote: z.string().describe('Hinweis zu offenen, nicht abgerechneten Leistungen'),
})

const meetingSummarySchema = z.object({
  summary: z.string().describe('Kompakte Zusammenfassung, Deutsch'),
  decisions: z.array(z.string()).max(10),
  actionItems: z
    .array(
      z.object({
        title: z.string(),
        assignee: z.string().nullable(),
        dueHint: z.string().nullable().describe('z.B. "nächste Woche" oder ein ISO-Datum'),
      }),
    )
    .max(15),
  openQuestions: z.array(z.string()).max(8),
})

const SYSTEM = [
  'Du unterstützt einen selbstständigen IT-/Daten-Berater bei der Projektsteuerung.',
  'Antworte immer auf Deutsch, sachlich und knapp. Keine Höflichkeitsfloskeln, keine Einleitung.',
  'Beziehe dich nur auf die gelieferten Daten. Wenn etwas fehlt, sage es statt zu raten.',
].join(' ')

// ---------------------------------------------------------------------------
// Projekt-Digest
// ---------------------------------------------------------------------------

export async function buildProjectDigest(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    include: {
      client: true,
      monitors: true,
      repos: { include: { runs: { orderBy: { startedAt: 'desc' }, take: 5 } } },
      notes_: { orderBy: { updatedAt: 'desc' }, take: 8 },
      meetings: { orderBy: { startsAt: 'desc' }, take: 5, include: { transcript: true } },
      actionItems: { where: { done: false } },
      invoices: { orderBy: { issueDate: 'desc' }, take: 5 },
    },
  })

  const [tracked, unbilled] = await Promise.all([
    prisma.timeEntry.aggregate({ where: { projectId }, _sum: { durationSec: true } }),
    prisma.timeEntry.aggregate({
      where: { projectId, billable: true, invoiceItemId: null, endedAt: { not: null } },
      _sum: { durationSec: true },
    }),
  ])

  const context = {
    projekt: {
      key: project.key,
      name: project.name,
      status: project.status,
      beschreibung: project.description,
      faellig: project.dueOn?.toISOString().slice(0, 10) ?? null,
      budgetEUR: project.budgetCents ? project.budgetCents / 100 : null,
    },
    kunde: project.client
      ? { name: project.client.name, firma: project.client.company }
      : null,
    zeit: {
      gesamt: formatDuration(tracked._sum.durationSec ?? 0),
      nichtAbgerechnet: formatDuration(unbilled._sum.durationSec ?? 0),
      nichtAbgerechnetEUR:
        Math.round(
          ((unbilled._sum.durationSec ?? 0) / 3600) *
            ((project.hourlyRateCents ?? project.client?.hourlyRateCents ?? 0) / 100),
        ) || null,
    },
    offeneAufgaben: project.actionItems.map((a) => ({
      titel: a.title,
      faellig: a.dueOn?.toISOString().slice(0, 10) ?? null,
    })),
    letzteNotizen: project.notes_.map((n) => ({
      titel: n.title,
      auszug: n.body.slice(0, 600),
      aktualisiert: n.updatedAt.toISOString().slice(0, 10),
    })),
    letzteMeetings: project.meetings.map((m) => ({
      titel: m.title,
      datum: m.startsAt.toISOString().slice(0, 10),
      zusammenfassung: m.summary,
      transkriptAuszug: m.transcript?.text?.slice(0, 1500) ?? null,
    })),
    betrieb: {
      monitore: project.monitors.map((m) => ({
        name: m.friendlyName,
        status: m.status,
        uptime30d: m.ratio30d,
      })),
      pipelines: project.repos.flatMap((r) =>
        r.runs.map((run) => ({
          repo: r.slug,
          branch: run.branch,
          status: run.status,
          zeit: run.startedAt?.toISOString() ?? null,
        })),
      ),
    },
    rechnungen: project.invoices.map((i) => ({
      nummer: i.number,
      status: i.status,
      betragEUR: i.totalCents / 100,
      faellig: i.dueDate.toISOString().slice(0, 10),
    })),
  }

  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: zodOutputFormat(projectDigestSchema),
    },
    messages: [
      {
        role: 'user',
        content: [
          'Erstelle einen Lagebericht für dieses Projekt.',
          'Priorisiere: (1) was mich Geld kostet oder bringt, (2) was blockiert, (3) was ich heute tun sollte.',
          '',
          '```json',
          JSON.stringify(context, null, 2),
          '```',
        ].join('\n'),
      },
    ],
  })

  const parsed = response.parsed_output
  if (!parsed) throw new Error('AI-Antwort konnte nicht geparst werden')

  return prisma.aiDigest.create({
    data: {
      projectId,
      kind: 'project',
      model: MODEL,
      headline: parsed.headline,
      content: parsed.summary,
      data: parsed,
    },
  })
}

// ---------------------------------------------------------------------------
// Meeting-Zusammenfassung + Action Items
// ---------------------------------------------------------------------------

export async function summarizeMeeting(meetingId: string) {
  const meeting = await prisma.meeting.findUniqueOrThrow({
    where: { id: meetingId },
    include: { transcript: true, project: true, client: true },
  })

  const source = meeting.transcript?.text?.trim() || meeting.minutes?.trim()
  if (!source) throw new Error('Weder Transkript noch Notizen vorhanden')

  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'medium',
      format: zodOutputFormat(meetingSummarySchema),
    },
    messages: [
      {
        role: 'user',
        content: [
          `Meeting: ${meeting.title}`,
          `Datum: ${meeting.startsAt.toISOString().slice(0, 16).replace('T', ' ')}`,
          meeting.project ? `Projekt: ${meeting.project.key} — ${meeting.project.name}` : '',
          meeting.client ? `Kunde: ${meeting.client.name}` : '',
          meeting.participants.length ? `Teilnehmende: ${meeting.participants.join(', ')}` : '',
          meeting.agenda ? `\nAgenda:\n${meeting.agenda}` : '',
          '',
          'Quelle (Transkript bzw. Mitschrift):',
          '"""',
          source.slice(0, 120_000),
          '"""',
          '',
          'Extrahiere Zusammenfassung, getroffene Entscheidungen, konkrete Action Items und offene Fragen.',
          'Action Items nur, wenn sie im Text tatsächlich vereinbart wurden.',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    ],
  })

  const parsed = response.parsed_output
  if (!parsed) throw new Error('AI-Antwort konnte nicht geparst werden')

  const updated = await prisma.meeting.update({
    where: { id: meetingId },
    data: {
      summary: parsed.summary,
      decisions: parsed.decisions,
      status: 'DONE',
    },
  })

  // Bestehende AI-Items ersetzen, manuell angelegte bleiben unangetastet.
  await prisma.actionItem.deleteMany({ where: { meetingId, source: 'AI', done: false } })
  await prisma.actionItem.createMany({
    data: parsed.actionItems.map((a: { title: string; assignee: string | null; dueHint: string | null }) => ({
      title: a.title,
      assignee: a.assignee,
      dueOn: parseDueHint(a.dueHint),
      meetingId,
      projectId: meeting.projectId,
      source: 'AI',
    })),
  })

  const actionItems = await prisma.actionItem.findMany({ where: { meetingId } })
  return { meeting: updated, actionItems, openQuestions: parsed.openQuestions }
}

function parseDueHint(hint: string | null): Date | null {
  if (!hint) return null
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(hint)
  if (iso) {
    const d = new Date(iso[0])
    return Number.isNaN(d.getTime()) ? null : d
  }
  const now = new Date()
  const lower = hint.toLowerCase()
  if (lower.includes('heute')) return now
  if (lower.includes('morgen')) return new Date(now.getTime() + 86_400_000)
  if (lower.includes('woche')) return new Date(now.getTime() + 7 * 86_400_000)
  if (lower.includes('monat')) return new Date(now.getTime() + 30 * 86_400_000)
  return null
}
