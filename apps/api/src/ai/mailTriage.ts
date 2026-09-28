// Der Anthropic-Zod-Helper erwartet Zod 4 — zod 3.25 liefert es unter /v4 mit.
import { z } from 'zod/v4'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { anthropic, MODEL } from './anthropic.js'

/**
 * Einordnung einer Mail, die keine Regel greifen konnte.
 *
 * Die AI bekommt bewusst nur Kurzfassungen der bekannten Leads, Kunden und
 * Projekte — Name, Firma, Adresse. Sie soll zuordnen, nicht erfinden: jede
 * Zuordnung muss auf eine der gelieferten Kennungen zeigen, sonst wird sie
 * verworfen (siehe mailSync.ts).
 */

const triageSchema = z.object({
  category: z
    .enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER'])
    .describe('LEAD nur bei echter Geschäftsanbahnung, nicht bei Newslettern'),
  leadId: z.string().nullable().describe('Kennung aus der Liste oder null'),
  clientId: z.string().nullable(),
  projectId: z.string().nullable(),
  /// Wenn die Mail eine neue Anfrage ist, für die es noch nichts gibt.
  newLead: z
    .object({
      title: z.string().describe('Kurz, z.B. "DWH-Ablösung Beispiel GmbH"'),
      contactName: z.string().nullable(),
      company: z.string().nullable(),
      summary: z.string().describe('Worum geht es, in 1-2 Sätzen'),
    })
    .nullable(),
  /// Genannte Summe in Euro, wenn die Mail eine nennt (Angebot, Budget).
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
      // Sortieren ist Routine — hier zählt Durchsatz, nicht Tiefe.
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
