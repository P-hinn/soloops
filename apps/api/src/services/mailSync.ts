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
  /** Gelesen, aber niemand konnte es einordnen — liegt im Eingang. */
  unassigned: number
  /** Fehlgeschlagene AI-Aufrufe. Nicht tödlich, aber nichts zum Verschweigen. */
  aiFailed: number
  error?: string
}

/**
 * Postfach abgleichen und neue Mails einsortieren.
 *
 * Reihenfolge ist Absicht: erst Regeln, dann AI. Eine Mail von einer bekannten
 * Adresse ist kostenlos und sicher zuzuordnen; die AI kostet Geld und irrt
 * gelegentlich. So läuft der Alltagsfall ohne einen einzigen API-Aufruf.
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
        // IMAP filtert SINCE nur tagesgenau und beim inkrementellen Lauf gar
        // nicht — die Grenze wird deshalb hier noch einmal durchgesetzt.
        if (mail.sentAt < since) continue

        // Eigene gesendete Mails zählen als Aktivität, landen aber nicht im
        // Eingang — sonst schlägt jede eigene Antwort als „unsortiert" auf.
        const outgoing = mail.fromEmail === account.email.toLowerCase()

        const existing = await prisma.mailMessage.findUnique({
          where: { messageId: mail.messageId },
          select: { id: true },
        })
        if (existing) continue

        const rule = matchByRule(mail, ctx)
        let assignment = rule
        // NONE heißt: nichts hat gegriffen. Früher stand hier RULE, was
        // behauptete, eine Regel habe entschieden — dabei hatte niemand
        // entschieden. Der Unterschied ist der zwischen „einsortiert" und
        // „übrig geblieben", und den will man sehen können.
        let assignedBy: 'RULE' | 'AI' | 'NONE' = rule ? 'RULE' : 'NONE'
        let suggestion: Prisma.InputJsonValue | undefined

        if (!rule && env.ANTHROPIC_API_KEY && !outgoing) {
          try {
            const ai = await triageMail(mail, ctx)
            if (ai) {
              assignment = constrainToKnown(ai, ctx)
              assignedBy = 'AI'
              // Hält die AI die Mail für eine neue Anfrage, hebt sie ihren
              // Vorschlag auf. Angelegt wird daraus nichts — das bleibt ein
              // Knopf im Eingang.
              if (ai.newLead) suggestion = { ...ai.newLead, amountEur: ai.amountEur }
            }
          } catch (err) {
            // Früher verschluckte ein stilles catch jeden Fehler. Dann sieht
            // niemand, dass die AI gar nicht läuft — und alles landet
            // unsortiert im Eingang, als wäre das ein Ergebnis.
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
    // Ein durchgelaufener Abruf mit lauter gescheiterten AI-Aufrufen ist kein
    // Erfolg. Der erste Fehler steht am Konto, damit er in der Oberfläche
    // auftaucht statt nur im Log.
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
// Zuordnung
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
 * Aus einer unsortierten Mail einen Lead machen. Bewusst ein eigener Schritt
 * auf Knopfdruck statt automatisch: sonst legt jede Werbemail einen Lead an.
 *
 * Die Reihenfolge der Quellen: was du übergibst, dann was die AI beim
 * Einlesen vorgeschlagen hat, dann die nackte Mail. Der Betreff als Titel ist
 * die letzte Rückfalloption, nicht die erste Wahl.
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
