import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { MailAccount } from '@prisma/client'
import { open } from './secretbox.js'

/**
 * IMAP-Zugriff — ausschließlich lesend.
 *
 * Es gibt hier bewusst kein Löschen, kein Verschieben und kein Setzen von
 * Flags: soloops soll das Postfach auswerten, nicht verwalten. Wer Mails
 * sortiert, tut das im Mailclient, und der nächste Lauf sieht dasselbe.
 */

export type FetchedMail = {
  uid: bigint
  messageId: string
  fromName: string | null
  fromEmail: string
  toEmails: string[]
  subject: string
  sentAt: Date
  bodyText: string
  snippet: string
}

export type FolderFetch = {
  folder: string
  uidValidity: bigint
  lastUid: bigint
  messages: FetchedMail[]
}

/** Alles, was für eine IMAP-Anmeldung nötig ist — auch ohne DB-Zeile. */
export type ImapCredentials = Pick<
  MailAccount,
  'imapHost' | 'imapPort' | 'imapSecure' | 'imapUser' | 'imapPassEnc'
>

function client(account: ImapCredentials): ImapFlow {
  return new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: account.imapUser, pass: open(account.imapPassEnc) },
    // Der eingebaute Logger schreibt jede IMAP-Zeile nach stdout, inklusive
    // Betreffzeilen. Im Worker-Log hat das nichts zu suchen.
    logger: false,
  })
}

/** Verbindung und Anmeldung prüfen, ohne etwas zu holen. */
export async function testConnection(
  account: ImapCredentials,
): Promise<{ ok: true; folders: string[] } | { ok: false; error: string }> {
  const imap = client(account)
  try {
    await imap.connect()
    const list = await imap.list()
    return { ok: true, folders: list.map((f) => f.path) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    await imap.logout().catch(() => undefined)
  }
}

/**
 * Holt neue Nachrichten aus allen konfigurierten Ordnern.
 *
 * `states` enthält je Ordner den Stand des letzten Laufs. Stimmt die
 * UIDVALIDITY nicht mehr, hat der Server die Nummerierung neu vergeben — dann
 * sind alle gemerkten UIDs wertlos und es wird ab `since` neu aufgesetzt.
 *
 * `since` ist die Untergrenze des Erstlaufs und jedes Neuaufsetzens. Sie kommt
 * vom Aufrufer, weil sie nicht nur am Konto hängt, sondern auch an der
 * globalen Grenze aus der Konfiguration.
 */
export async function fetchNew(
  account: MailAccount,
  states: Map<string, { uidValidity: bigint | null; lastUid: bigint }>,
  maxPerRun: number,
  since: Date,
): Promise<FolderFetch[]> {
  const imap = client(account)
  const out: FolderFetch[] = []

  try {
    await imap.connect()

    for (const folder of account.folders) {
      const lock = await imap.getMailboxLock(folder)
      try {
        const box = imap.mailbox
        if (typeof box === 'boolean') continue
        const uidValidity = BigInt(box.uidValidity)
        const prev = states.get(folder)
        const reset = !prev || prev.uidValidity === null || prev.uidValidity !== uidValidity
        const lastUid = reset ? 0n : prev.lastUid

        const range = reset ? { since } : { uid: `${(lastUid + 1n).toString()}:*` }

        const messages: FetchedMail[] = []
        let highest = lastUid

        for await (const msg of imap.fetch(range, { uid: true, source: true })) {
          const uid = BigInt(msg.uid)
          // Bei `uid: "n:*"` liefert IMAP mindestens eine Nachricht zurück,
          // auch wenn es nichts Neues gibt — die letzte bekannte. Überspringen.
          if (uid <= lastUid) continue
          if (uid > highest) highest = uid
          if (!msg.source) continue

          const parsed = await parse(msg.source, uid)
          if (parsed) messages.push(parsed)
          if (messages.length >= maxPerRun) break
        }

        out.push({ folder, uidValidity, lastUid: highest, messages })
      } finally {
        lock.release()
      }
    }
  } finally {
    await imap.logout().catch(() => undefined)
  }

  return out
}

async function parse(source: Buffer, uid: bigint): Promise<FetchedMail | null> {
  const mail = await simpleParser(source, { skipImageLinks: true })

  const from = mail.from?.value?.[0]
  if (!from?.address) return null

  const to = mail.to
  const toList = Array.isArray(to) ? to : to ? [to] : []
  const toEmails = toList
    .flatMap((a) => a.value)
    .map((v) => v.address)
    .filter((a): a is string => Boolean(a))

  // Ohne Message-ID keine verlässliche Dublettenerkennung — dann eine aus
  // Konto-UID und Datum bauen, damit die Mail trotzdem genau einmal landet.
  const messageId =
    mail.messageId ?? `<soloops-${uid}-${(mail.date ?? new Date()).getTime()}@local>`

  const bodyText = (mail.text ?? stripHtml(mail.html || '')).trim()

  return {
    uid,
    messageId,
    fromName: from.name || null,
    fromEmail: from.address.toLowerCase(),
    toEmails,
    subject: mail.subject?.trim() || '(ohne Betreff)',
    sentAt: mail.date ?? new Date(),
    // Der Text geht in die Volltextsuche und in die AI-Zuordnung. 32k Zeichen
    // sind mehr als jeder ernst gemeinte Geschäftsbrief.
    bodyText: bodyText.slice(0, 32_000),
    snippet: bodyText.replace(/\s+/g, ' ').slice(0, 300),
  }
}

function stripHtml(html: string | false): string {
  if (!html) return ''
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
}
