import { z } from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { anthropic, MODEL } from './anthropic.js'

/**
 * Free text -> structured plan -> confirmation -> creation.
 *
 * Two stages on purpose. A sentence like "meeting for a new project" is
 * underspecified; if it turned into a client, a project and a calendar entry
 * without asking, you would clean up more than you saved. The plan is a
 * proposal you see before anything happens.
 */

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const entityRef = z.object({
  action: z.enum(['use', 'create', 'none']).describe('use = bestehendes nehmen, create = neu'),
  id: z.string().nullable().describe('nur bei action=use: die Id aus dem Kontext'),
  name: z.string().nullable(),
})

const planSchema = z.object({
  understood: z.string().describe('Ein Satz auf Deutsch: was soll passieren?'),
  confidence: z.enum(['high', 'medium', 'low']),
  questions: z
    .array(z.string())
    .describe('Offene Punkte, die du geraten hast. Leer, wenn alles klar war.'),

  client: entityRef.extend({
    company: z.string().nullable(),
    email: z.string().nullable(),
  }),

  project: entityRef.extend({
    key: z.string().nullable().describe('Kürzel in GROSSBUCHSTABEN, z.B. ACME-DWH'),
    description: z.string().nullable(),
  }),

  event: z.object({
    create: z.boolean(),
    title: z.string().nullable(),
    startsAt: z.string().nullable().describe('ISO-8601 mit Zeitzonen-Offset'),
    endsAt: z.string().nullable().describe('ISO-8601 mit Zeitzonen-Offset'),
    kind: z.enum(['FOCUS', 'MEETING', 'ADMIN', 'PERSONAL', 'TRAVEL']),
    location: z.string().nullable(),
    withVideo: z.boolean().describe('true, wenn ein Videoraum gebraucht wird'),
  }),

  meeting: z.object({
    create: z.boolean(),
    title: z.string().nullable(),
    participants: z.array(z.string()),
    agenda: z.string().nullable().describe('Markdown, kurze Stichpunkte'),
  }),

  note: z.object({
    create: z.boolean(),
    title: z.string().nullable(),
    body: z.string().nullable(),
    tags: z.array(z.string()),
  }),

  actionItems: z.array(
    z.object({
      title: z.string(),
      dueOn: z.string().nullable().describe('ISO-Datum oder null'),
    }),
  ),

  timer: z.object({
    start: z.boolean(),
    description: z.string().nullable(),
  }),
})

export type AssistantPlan = z.infer<typeof planSchema>

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const SYSTEM = [
  'Du bist der Schnelleinstieg im Betriebssystem eines selbstständigen IT-Beraters.',
  'Aus einem kurzen Satz baust du einen Plan, welche Datensätze angelegt werden sollen.',
  '',
  'Regeln:',
  '- Nimm bestehende Kunden und Projekte, wenn der Text sie erkennbar meint (action=use mit id).',
  '  Lege nur an, was es wirklich noch nicht gibt.',
  '- Setze `create` nur dort auf true, wo der Text es tatsächlich verlangt. Ein Termin allein',
  '  braucht kein Projekt, keine Notiz und keinen Timer.',
  '- Zeiten: Wenn keine Uhrzeit genannt ist, nimm einen freien Slot aus dem Kontext.',
  '  Termine liegen Mo–Fr im Arbeitszeitfenster. Standarddauer 60 Minuten.',
  '- Projektkürzel: kurz, GROSSBUCHSTABEN, aus Kunde und Thema, z.B. ACME-DWH. Nie doppelt.',
  '- Videoraum nur bei Kundenterminen oder wenn explizit gewünscht.',
  '- Was du geraten hast, gehört in `questions` — knapp, eine Zeile pro Punkt.',
  '- Antworte ausschließlich auf Deutsch.',
].join('\n')

export async function planFromText(text: string): Promise<AssistantPlan> {
  const [clients, projects, freeSlots] = await Promise.all([
    prisma.client.findMany({
      where: { archived: false },
      select: { id: true, name: true, company: true },
      orderBy: { name: 'asc' },
    }),
    prisma.project.findMany({
      where: { status: { in: ['LEAD', 'ACTIVE', 'PAUSED'] } },
      select: { id: true, key: true, name: true, clientId: true, status: true },
      orderBy: { key: 'asc' },
    }),
    nextFreeSlots(),
  ])

  const now = new Date()
  const context = {
    jetzt: now.toISOString(),
    wochentag: now.toLocaleDateString('de-DE', { weekday: 'long', timeZone: env.TZ }),
    zeitzone: env.TZ,
    arbeitszeit: '09:00–18:00, Mo–Fr',
    videoStandard: env.VIDEO_PROVIDER,
    kunden: clients,
    projekte: projects,
    freieSlots: freeSlots.slice(0, 12),
  }

  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: zodOutputFormat(planSchema) },
    messages: [
      {
        role: 'user',
        content: [
          'Eingabe:',
          `"""${text}"""`,
          '',
          'Kontext:',
          '```json',
          JSON.stringify(context, null, 2),
          '```',
        ].join('\n'),
      },
    ],
  })

  const plan = response.parsed_output
  if (!plan) throw new Error('Der Plan konnte nicht gelesen werden — bitte anders formulieren.')
  return plan
}

/** Free slots over the next two weeks, so the model can schedule for real. */
async function nextFreeSlots(): Promise<{ start: string; end: string; minutes: number }[]> {
  const from = new Date()
  const days = 14
  const to = new Date(from.getTime() + days * 86_400_000)
  const events = await prisma.calendarEvent.findMany({
    where: { startsAt: { lt: to }, endsAt: { gt: from } },
    orderBy: { startsAt: 'asc' },
  })

  const slots: { start: string; end: string; minutes: number }[] = []
  for (let d = 0; d < days; d++) {
    const day = new Date(from)
    day.setDate(day.getDate() + d)
    if (day.getDay() === 0 || day.getDay() === 6) continue

    let cursor = new Date(day)
    cursor.setHours(9, 0, 0, 0)
    const dayEnd = new Date(day)
    dayEnd.setHours(18, 0, 0, 0)
    if (cursor < from) cursor = new Date(Math.ceil(from.getTime() / 1_800_000) * 1_800_000)

    for (const e of events.filter((e) => e.endsAt > cursor && e.startsAt < dayEnd)) {
      if (e.startsAt.getTime() - cursor.getTime() >= 60 * 60_000) {
        slots.push({
          start: cursor.toISOString(),
          end: e.startsAt.toISOString(),
          minutes: Math.round((e.startsAt.getTime() - cursor.getTime()) / 60_000),
        })
      }
      if (e.endsAt > cursor) cursor = new Date(e.endsAt)
    }
    if (dayEnd.getTime() - cursor.getTime() >= 60 * 60_000) {
      slots.push({
        start: cursor.toISOString(),
        end: dayEnd.toISOString(),
        minutes: Math.round((dayEnd.getTime() - cursor.getTime()) / 60_000),
      })
    }
  }
  return slots
}

export { planSchema }
