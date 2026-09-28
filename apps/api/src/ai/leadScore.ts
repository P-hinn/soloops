// Der Anthropic-Zod-Helper erwartet Zod 4 — zod 3.25 liefert es unter /v4 mit.
import { z } from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { prisma } from '../db.js'
import { anthropic, MODEL } from './anthropic.js'
import { leadValueCents, stalenessDays, STAGE_LABEL } from '../services/leads.js'

/**
 * Zweitmeinung zu einem Lead.
 *
 * Der Score ersetzt `probability` nicht, er steht daneben. Deine Einschätzung
 * trägt den Forecast; die AI darf widersprechen, und genau die Differenz ist
 * das Interessante — sie zeigt, wo du zu optimistisch oder zu vorsichtig bist.
 */

const scoreSchema = z.object({
  score: z.number().min(0).max(100).describe('Abschlusswahrscheinlichkeit in Prozent'),
  reason: z.string().describe('2-3 Sätze: was trägt, was fehlt'),
  nextStep: z.string().describe('Der eine konkrete nächste Schritt'),
  risks: z.array(z.string()).max(3),
})

const SYSTEM = [
  'Du bewertest Vertriebschancen eines selbstständigen IT- und Datenberaters.',
  'Antworte auf Deutsch, nüchtern, ohne Vertriebsjargon und ohne Motivationssprache.',
  'Bewerte streng: ein Lead ohne Reaktion seit Wochen ist nicht vielversprechend,',
  'egal wie groß die Summe ist. Ein konkretes Angebot mit Rückfragen dagegen schon.',
  'Beziehe dich nur auf die gelieferten Daten.',
].join(' ')

export async function scoreLead(leadId: string) {
  const lead = await prisma.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: {
      offers: { orderBy: { createdAt: 'desc' } },
      activities: { orderBy: { occurredAt: 'desc' }, take: 20 },
      mails: { orderBy: { sentAt: 'desc' }, take: 10 },
      client: { select: { name: true } },
    },
  })

  const context = {
    lead: {
      titel: lead.title,
      stufe: STAGE_LABEL[lead.stage],
      quelle: lead.source,
      firma: lead.company ?? lead.client?.name ?? null,
      kontakt: lead.contactName,
      wertEUR: leadValueCents(lead) / 100,
      deineWahrscheinlichkeit: lead.probability,
      erwarteterAbschluss: lead.expectedCloseOn?.toISOString().slice(0, 10) ?? null,
      tageOhneAktivitaet: stalenessDays(lead),
      notizen: lead.notes,
    },
    angebote: lead.offers.map((o) => ({
      titel: o.title,
      status: o.status,
      betragEUR: o.amountCents / 100,
      verschickt: o.sentOn?.toISOString().slice(0, 10) ?? null,
      gueltigBis: o.validUntil?.toISOString().slice(0, 10) ?? null,
      umfang: o.scope,
    })),
    verlauf: lead.activities.map((a) => ({
      art: a.kind,
      wann: a.occurredAt.toISOString().slice(0, 10),
      was: a.body.slice(0, 300),
    })),
    mailverlauf: lead.mails.map((m) => ({
      von: m.fromEmail,
      betreff: m.subject,
      wann: m.sentAt.toISOString().slice(0, 10),
      auszug: m.snippet,
    })),
  }

  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: zodOutputFormat(scoreSchema) },
    messages: [
      {
        role: 'user',
        content: [
          'Bewerte diese Vertriebschance.',
          'Achte besonders auf: Reaktionsverhalten der Gegenseite, Alter des letzten Kontakts,',
          'ob ein Angebot draußen ist und ob es darauf eine Reaktion gab.',
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

  return prisma.lead.update({
    where: { id: leadId },
    data: {
      aiScore: Math.round(parsed.score),
      aiScoreReason: [
        parsed.reason,
        parsed.risks.length ? `Risiken: ${parsed.risks.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n\n'),
      aiNextStep: parsed.nextStep,
      aiScoredAt: new Date(),
    },
  })
}

/** Alle offenen Leads neu bewerten. Läuft nachts im Worker. */
export async function scoreOpenLeads() {
  const leads = await prisma.lead.findMany({
    where: { archived: false, stage: { notIn: ['WON', 'LOST'] } },
    select: { id: true, title: true },
  })

  const scored: string[] = []
  for (const lead of leads) {
    try {
      await scoreLead(lead.id)
      scored.push(lead.title)
    } catch (err) {
      console.error(`[leadScore] ${lead.title}: ${(err as Error).message}`)
    }
  }
  return { scored: scored.length, total: leads.length }
}
