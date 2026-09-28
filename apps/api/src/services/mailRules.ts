/**
 * Zuordnung per Regel — ohne Prisma und ohne AI, damit sie testbar bleibt
 * und im Normalfall nichts kostet.
 */

export type MailCategoryName = 'LEAD' | 'PROJECT' | 'INVOICE' | 'ADMIN' | 'OTHER'

export type Assignment = {
  category: MailCategoryName
  leadId: string | null
  clientId: string | null
  projectId: string | null
  confidence: number | null
  reason: string | null
}

export type RuleContext = {
  ownEmail: string
  leads: { id: string; title: string; company: string | null; email: string | null }[]
  clients: { id: string; name: string; company: string | null; email: string | null }[]
  projects: { id: string; key: string; name: string; client: string | null }[]
}

/**
 * Bei diesen Domains sagt die Adresse nichts über die Organisation aus. Ohne
 * die Liste würde jede GMX-Adresse dem erstbesten Kunden mit GMX-Konto
 * zugeschlagen.
 */
export const FREEMAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'web.de',
  'gmx.de',
  'gmx.net',
  'gmx.at',
  'gmx.ch',
  't-online.de',
  'outlook.com',
  'outlook.de',
  'hotmail.com',
  'hotmail.de',
  'live.com',
  'live.de',
  'yahoo.com',
  'yahoo.de',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'freenet.de',
  'arcor.de',
  'posteo.de',
  'mailbox.org',
  'proton.me',
  'protonmail.com',
  'tutanota.com',
  'tuta.com',
])

/**
 * Absenderadresse gegen bekannte Leads und Kunden. Trifft im Alltag fast
 * immer — laufende Korrespondenz kommt von Adressen, die schon im System
 * stehen. Kostet nichts und kann sich nicht vertun.
 */
export function matchByRule(
  mail: { fromEmail: string; toEmails: string[] },
  ctx: RuleContext,
): Assignment | null {
  const own = ctx.ownEmail.toLowerCase()
  const addresses = [mail.fromEmail.toLowerCase(), ...mail.toEmails.map((a) => a.toLowerCase())]
    // Die eigene Adresse steht in jeder Mail und taugt nicht zur Zuordnung.
    .filter((a) => a !== own)

  for (const lead of ctx.leads) {
    const email = lead.email?.toLowerCase()
    if (email && addresses.includes(email)) {
      return {
        category: 'LEAD',
        leadId: lead.id,
        clientId: null,
        projectId: null,
        confidence: 1,
        reason: `Absender ist der Kontakt von „${lead.title}"`,
      }
    }
  }

  for (const client of ctx.clients) {
    const email = client.email?.toLowerCase()
    if (email && addresses.includes(email)) {
      return {
        category: 'PROJECT',
        leadId: null,
        clientId: client.id,
        projectId: null,
        confidence: 1,
        reason: `Absender ist ${client.name}`,
      }
    }
  }

  // Gleiche Domain wie ein bekannter Kunde — schwächeres Signal, reicht aber
  // für die Zuordnung zum Kunden.
  const domain = mail.fromEmail.toLowerCase().split('@')[1]
  if (domain && !FREEMAIL.has(domain)) {
    for (const client of ctx.clients) {
      if (client.email?.toLowerCase().endsWith(`@${domain}`)) {
        return {
          category: 'PROJECT',
          leadId: null,
          clientId: client.id,
          projectId: null,
          confidence: 0.7,
          reason: `Gleiche Domain wie ${client.name}`,
        }
      }
    }
  }

  return null
}

/** Firmenname aus der Absenderdomain raten. Bei Freemail geht das nicht. */
export function domainToCompany(email: string): string | null {
  const domain = email.toLowerCase().split('@')[1]
  if (!domain || FREEMAIL.has(domain)) return null
  const name = domain.split('.')[0]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null
}

/**
 * Ein AI-Vorschlag darf nur auf Kennungen zeigen, die er selbst bekommen hat.
 * Alles andere ist geraten und wird verworfen.
 */
export function constrainToKnown(
  ai: {
    category: string
    leadId: string | null
    clientId: string | null
    projectId: string | null
    confidence: number
    reason: string
  } | null,
  ctx: RuleContext,
): Assignment | null {
  if (!ai) return null
  return {
    category: ai.category as MailCategoryName,
    leadId: ctx.leads.some((l) => l.id === ai.leadId) ? ai.leadId : null,
    clientId: ctx.clients.some((c) => c.id === ai.clientId) ? ai.clientId : null,
    projectId: ctx.projects.some((p) => p.id === ai.projectId) ? ai.projectId : null,
    confidence: ai.confidence,
    reason: ai.reason,
  }
}

/**
 * Ab wann ein Konto gelesen wird: das spätere aus Kontostart und der harten
 * Grenze aus der Konfiguration. Ein Konto darf nur nach vorn abweichen —
 * sonst holt ein Neuaufsetzen nach UIDVALIDITY-Wechsel doch wieder das Archiv.
 */
export function syncWindowStart(accountSince: Date, floor: Date): Date {
  return accountSince > floor ? accountSince : floor
}
