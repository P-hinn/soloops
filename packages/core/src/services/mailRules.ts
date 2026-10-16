/**
 * Matching by rule — without Prisma and without AI, so that it stays testable
 * and costs nothing in the normal case.
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
 * With these domains the address says nothing about the organisation. Without
 * the list, every GMX address would be attributed to the first client who
 * happens to use GMX.
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
 * The sender address against known leads and clients. Hits almost every time
 * in practice — ongoing correspondence comes from addresses that are already
 * in the system. Costs nothing and cannot be wrong.
 */
export function matchByRule(
  mail: { fromEmail: string; toEmails: string[] },
  ctx: RuleContext,
): Assignment | null {
  const own = ctx.ownEmail.toLowerCase()
  const addresses = [mail.fromEmail.toLowerCase(), ...mail.toEmails.map((a) => a.toLowerCase())]
    // Your own address is in every mail and is no use for matching.
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

  // Same domain as a known client — a weaker signal, but enough to attribute
  // the mail to that client.
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

/** Guess the company name from the sender domain. Freemail rules that out. */
export function domainToCompany(email: string): string | null {
  const domain = email.toLowerCase().split('@')[1]
  if (!domain || FREEMAIL.has(domain)) return null
  const name = domain.split('.')[0]
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null
}

/**
 * An AI suggestion may only point at identifiers it was handed itself.
 * Anything else is guesswork and gets discarded.
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
 * Where reading an account starts: the later of the account start and the
 * hard floor from the configuration. An account may only deviate forwards —
 * otherwise a reset after a UIDVALIDITY change pulls in the archive after all.
 */
export function syncWindowStart(accountSince: Date, floor: Date): Date {
  return accountSince > floor ? accountSince : floor
}

/** What the AI noted about a possible new enquiry while reading. */
export type LeadSuggestion = {
  title?: string | null
  contactName?: string | null
  company?: string | null
  summary?: string | null
  amountEur?: number | null
}

/** The stored suggestion is JSON from the database — so validate it. */
export function readSuggestion(value: unknown): LeadSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const str = (k: string) => (typeof v[k] === 'string' && v[k] ? (v[k] as string) : null)
  return {
    title: str('title'),
    contactName: str('contactName'),
    company: str('company'),
    summary: str('summary'),
    amountEur: typeof v.amountEur === 'number' ? v.amountEur : null,
  }
}
