import type { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { fetchNew } from './imap.js'
import { triageMail, type TriageContext } from '../ai/mailTriage.js'
import { touchLead } from './leads.js'
import {
  constrainToKnown,
  domainToCompany,
  matchByRule,
  readSuggestion,
  syncWindowStart,
} from './mailRules.js'

export type MailSyncResult = {
  account: string
  fetched: number
  assigned: number
  byRule: number
  byAi: number
  /** Read, but nobody could place it — sits in the inbox. */
  unassigned: number
  /** Failed AI calls. Not fatal, but not something to swallow either. */
  aiFailed: number
  error?: string
}

/**
 * Sync the mailbox and file the new mail.
 *
 * The order is deliberate: rules first, AI second. A mail from a known
 * address is free and certain to match; the AI costs money and is
 * occasionally wrong. That way the everyday case runs without a single API
 * call.
 */
export async function syncMailAccount(accountId: string): Promise<MailSyncResult> {
  const account = await prisma.mailAccount.findUniqueOrThrow({ where: { id: accountId } })
  const result: MailSyncResult = {
    account: account.email,
    fetched: 0,
    assigned: 0,
    byRule: 0,
    byAi: 0,
    unassigned: 0,
    aiFailed: 0,
  }
  const aiErrors: string[] = []

  if (!account.enabled) return result

  try {
    const states = new Map(
      (await prisma.mailFolderState.findMany({ where: { accountId } })).map((s) => [
        s.folder,
        { uidValidity: s.uidValidity, lastUid: s.lastUid },
      ]),
    )

    const since = syncWindowStart(account.syncSince, env.MAIL_SYNC_FROM)

    const folders = await fetchNew(account, states, env.MAIL_MAX_PER_RUN, since)
    const ctx = await buildContext(account.email)

    for (const folder of folders) {
      for (const mail of folder.messages) {
        // IMAP filters SINCE only to the day, and not at all on incremental
        // runs — so the floor is enforced once more right here.
        if (mail.sentAt < since) continue

        // Your own sent mail counts as activity but does not land in the
        // inbox — otherwise every reply you write shows up as "unfiled".
        const outgoing = mail.fromEmail === account.email.toLowerCase()

        const existing = await prisma.mailMessage.findUnique({
          where: { messageId: mail.messageId },
          select: { id: true },
        })
        if (existing) continue

        const rule = matchByRule(mail, ctx)
        let assignment = rule
        // NONE means: nothing caught. This used to say RULE, which claimed a
        // rule had decided — when in fact nobody had. That is the difference
        // between "filed" and "left over", and you want to be able to see it.
        let assignedBy: 'RULE' | 'AI' | 'NONE' = rule ? 'RULE' : 'NONE'
        let suggestion: Prisma.InputJsonValue | undefined

        if (!rule && env.ANTHROPIC_API_KEY && !outgoing) {
          try {
            const ai = await triageMail(mail, ctx)
            if (ai) {
              assignment = constrainToKnown(ai, ctx)
              assignedBy = 'AI'
              // If the AI takes the mail for a new enquiry, its suggestion is
              // kept. Nothing is created from it — that stays a button in the
              // inbox.
              if (ai.newLead) suggestion = { ...ai.newLead, amountEur: ai.amountEur }
            }
          } catch (err) {
            // A silent catch used to swallow every error. Then nobody sees
            // that the AI is not running at all — and everything lands
            // unfiled in the inbox as though that were a result.
            aiErrors.push((err as Error).message)
          }
        }

        await prisma.mailMessage.create({
          data: {
            accountId,
            messageId: mail.messageId,
            uid: mail.uid,
            folder: folder.folder,
            fromName: mail.fromName,
            fromEmail: mail.fromEmail,
            toEmails: mail.toEmails,
            subject: mail.subject,
            sentAt: mail.sentAt,
            bodyText: mail.bodyText,
            snippet: mail.snippet,
            category: assignment?.category ?? 'OTHER',
            assignedBy,
            leadSuggestion: suggestion,
            confidence: assignment?.confidence ?? null,
            aiReason: assignment?.reason ?? null,
            leadId: assignment?.leadId ?? null,
            clientId: assignment?.clientId ?? null,
            projectId: assignment?.projectId ?? null,
            handled: outgoing,
          },
        })

        result.fetched += 1
        if (assignment?.leadId) {
          await touchLead(assignment.leadId, {
            kind: 'MAIL',
            body: `${outgoing ? 'An' : 'Von'} ${outgoing ? (mail.toEmails[0] ?? '?') : mail.fromEmail}: ${mail.subject}`,
            occurredAt: mail.sentAt,
            source: 'SYSTEM',
          })
        }
        if (assignment?.leadId || assignment?.clientId || assignment?.projectId) {
          result.assigned += 1
          if (assignedBy === 'RULE') result.byRule += 1
          else result.byAi += 1
        } else {
          result.unassigned += 1
        }
      }

      await prisma.mailFolderState.upsert({
        where: { accountId_folder: { accountId, folder: folder.folder } },
        create: {
          accountId,
          folder: folder.folder,
          uidValidity: folder.uidValidity,
          lastUid: folder.lastUid,
        },
        update: { uidValidity: folder.uidValidity, lastUid: folder.lastUid },
      })
    }

    result.aiFailed = aiErrors.length
    // A run that completed with nothing but failed AI calls is not a
    // success. The first error is stored on the account so that it shows up
    // in the interface and not only in the log.
    const note = aiErrors.length
      ? `${aiErrors.length} AI-Zuordnung(en) fehlgeschlagen: ${aiErrors[0]}`
      : null

    await prisma.mailAccount.update({
      where: { id: accountId },
      data: { lastSyncAt: new Date(), lastError: note },
    })
  } catch (err) {
    result.error = (err as Error).message
    await prisma.mailAccount.update({
      where: { id: accountId },
      data: { lastSyncAt: new Date(), lastError: result.error },
    })
  }

  return result
}

export async function syncAllMailAccounts(): Promise<MailSyncResult[]> {
  const accounts = await prisma.mailAccount.findMany({ where: { enabled: true } })
  const out: MailSyncResult[] = []
  for (const a of accounts) out.push(await syncMailAccount(a.id))
  return out
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

async function buildContext(ownEmail: string): Promise<TriageContext> {
  const [leads, clients, projects] = await Promise.all([
    prisma.lead.findMany({
      where: { archived: false, stage: { notIn: ['WON', 'LOST'] } },
      select: { id: true, title: true, company: true, contactEmail: true },
      orderBy: { lastActivityAt: 'desc' },
      take: 60,
    }),
    prisma.client.findMany({
      where: { archived: false },
      select: { id: true, name: true, company: true, email: true },
      take: 100,
    }),
    prisma.project.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, key: true, name: true, client: { select: { name: true } } },
      take: 60,
    }),
  ])

  return {
    ownEmail: ownEmail.toLowerCase(),
    leads: leads.map((l) => ({
      id: l.id,
      title: l.title,
      company: l.company,
      email: l.contactEmail,
    })),
    clients: clients.map((c) => ({ id: c.id, name: c.name, company: c.company, email: c.email })),
    projects: projects.map((p) => ({
      id: p.id,
      key: p.key,
      name: p.name,
      client: p.client?.name ?? null,
    })),
  }
}

/**
 * Turn an unfiled mail into a lead. Deliberately a separate step at the push
 * of a button rather than automatic: otherwise every marketing mail creates
 * a lead.
 *
 * The order of sources: what you pass in, then what the AI suggested while
 * reading, then the bare mail. The subject line as a title is the last
 * fallback, not the first choice.
 */
export async function leadFromMail(
  mailId: string,
  overrides: Prisma.LeadCreateInput | null = null,
) {
  const mail = await prisma.mailMessage.findUniqueOrThrow({ where: { id: mailId } })
  const hint = readSuggestion(mail.leadSuggestion)

  const lead = await prisma.lead.create({
    data: {
      title: overrides?.title ?? hint?.title ?? mail.subject,
      source: overrides?.source ?? 'WEBSITE',
      contactName: overrides?.contactName ?? hint?.contactName ?? mail.fromName,
      contactEmail: overrides?.contactEmail ?? mail.fromEmail,
      company: overrides?.company ?? hint?.company ?? domainToCompany(mail.fromEmail),
      notes: overrides?.notes ?? hint?.summary ?? mail.snippet,
      valueCents:
        overrides?.valueCents ?? (hint?.amountEur ? Math.round(hint.amountEur * 100) : null),
      ...(overrides ?? {}),
    },
  })

  await prisma.mailMessage.update({
    where: { id: mailId },
    data: { leadId: lead.id, category: 'LEAD', assignedBy: 'MANUAL', handled: true },
  })

  await touchLead(lead.id, {
    kind: 'MAIL',
    body: `Lead aus Mail: ${mail.subject}`,
    occurredAt: mail.sentAt,
    source: 'SYSTEM',
  })

  return lead
}
