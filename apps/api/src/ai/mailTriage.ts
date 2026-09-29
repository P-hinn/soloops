// The Anthropic Zod helper expects Zod 4 — zod 3.25 ships it under /v4.
import { z } from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { anthropic, MODEL } from './anthropic.js'

/**
 * Placing a mail that no rule could catch.
 *
 * The model deliberately only gets short summaries of the known leads,
 * clients and projects — name, company, address. It is meant to match, not
 * invent: every match has to point at one of the supplied identifiers, or it
 * is discarded (see mailSync.ts).
 */

const triageSchema = z.object({
  category: z
    .enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER'])
    .describe('LEAD nur bei echter Geschäftsanbahnung, nicht bei Newslettern'),
  leadId: z.string().nullable().describe('Kennung aus der Liste oder null'),
  clientId: z.string().nullable(),
  projectId: z.string().nullable(),
  /// Set when the mail is a new enquiry with nothing on file yet.
  newLead: z
    .object({
      title: z.string().describe('Kurz, z.B. "DWH-Ablösung Beispiel GmbH"'),
      contactName: z.string().nullable(),
      company: z.string().nullable(),
      summary: z.string().describe('Worum geht es, in 1-2 Sätzen'),
    })
    .nullable(),
  /// An amount in euro where the mail names one (offer, budget).
  amountEur: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().describe('Ein Satz, warum diese Einordnung'),
})

export type MailTriage = z.infer<typeof triageSchema>

export type TriageContext = {
  ownEmail: string
  leads: { id: string; title: string; company: string | null; email: string | null }[]
  clients: { id: string; name: string; company: string | null; email: string | null }[]
  projects: { id: string; key: string; name: string; client: string | null }[]
}

const SYSTEM = [
  'Du sortierst den Posteingang eines selbstständigen IT- und Datenberaters.',
  'Antworte auf Deutsch, sachlich, ohne Floskeln.',
  'Ordne nur zu, wenn die Mail eindeutig dorthin gehört. Im Zweifel OTHER mit niedriger Confidence.',
  'leadId, clientId und projectId müssen exakt einer gelieferten Kennung entsprechen — erfinde keine.',
  'Newsletter, Rechnungen von Dienstleistern, Werbung und Automatisches sind niemals LEAD.',
].join(' ')

export async function triageMail(
  mail: { fromName: string | null; fromEmail: string; subject: string; bodyText: string },
  ctx: TriageContext,
): Promise<MailTriage | null> {
  const response = await anthropic().messages.parse({
    model: MODEL,
    max_tokens: 2000,
    system: SYSTEM,
    output_config: {
      // Filing is routine — throughput counts here, not depth.
      effort: 'low',
      format: zodOutputFormat(triageSchema),
    },
    messages: [
      {
        role: 'user',
        content: [
          `Mein eigenes Postfach: ${ctx.ownEmail}`,
          '',
          'Bekannte Leads:',
          ctx.leads.length
            ? ctx.leads
                .map((l) => `- ${l.id} | ${l.title} | ${l.company ?? '-'} | ${l.email ?? '-'}`)
                .join('\n')
            : '- keine',
          '',
          'Bekannte Kunden:',
          ctx.clients.length
            ? ctx.clients
                .map((c) => `- ${c.id} | ${c.name} | ${c.company ?? '-'} | ${c.email ?? '-'}`)
                .join('\n')
            : '- keine',
          '',
          'Laufende Projekte:',
          ctx.projects.length
            ? ctx.projects
                .map((p) => `- ${p.id} | ${p.key} ${p.name} | ${p.client ?? '-'}`)
                .join('\n')
            : '- keine',
          '',
          '--- Mail ---',
          `Von: ${mail.fromName ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail}`,
          `Betreff: ${mail.subject}`,
          '',
          mail.bodyText.slice(0, 8000),
        ].join('\n'),
      },
    ],
  })

  return response.parsed_output ?? null
}
