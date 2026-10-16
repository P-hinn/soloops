import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import type { MailAccount } from '@prisma/client'
import { open } from './secretbox.js'

/**
 * IMAP access — read-only, strictly.
 *
 * There is deliberately no delete, no move and no flag setting here: soloops
 * is meant to read the mailbox, not manage it. You sort your mail in your
 * mail client, and the next run sees the same thing.
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

/** Everything an IMAP login needs — including without a database row. */
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
    // The built-in logger writes every IMAP line to stdout, subject lines
    // included. That has no business being in the worker log.
    logger: false,
  })
}

/** Check connection and login without fetching anything. */
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
 * Fetches new messages from every configured folder.
 *
 * `states` holds the last run's position per folder. If the UIDVALIDITY no
 * longer matches, the server reassigned the numbering — then every
 * remembered UID is worthless and we start over from `since`.
 *
 * `since` is the floor for the first run and for every reset. It comes from
 * the caller, because it depends not only on the account but also on the
 * global floor from the configuration.
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

        const range = reset
          ? await firstWindow(imap, box.exists, since, maxPerRun)
          : { uid: `${(lastUid + 1n).toString()}:*` }

        const messages: FetchedMail[] = []
        // The cursor may only move as far as we actually got. Advance it
        // while merely looking, and any abort — a limit, a broken message, a
        // connection error — skips everything in between for good.
        let processed = lastUid

        if (range) {
          for await (const msg of imap.fetch(range, { uid: true, source: true })) {
            const uid = BigInt(msg.uid)
            // With `uid: "n:*"` IMAP returns at least one message even when
            // there is nothing new — the last known one. Skip it.
            if (uid <= lastUid) continue

            if (msg.source) {
              const parsed = await parse(msg.source, uid)
              if (parsed) messages.push(parsed)
            }

            processed = uid
            if (messages.length >= maxPerRun) break
          }
        }

        out.push({ folder, uidValidity, lastUid: processed, messages })
      } finally {
        lock.release()
      }
    }
  } finally {
    await imap.logout().catch(() => undefined)
  }

  return out
}

/**
 * Which slice does the very first run fetch — and every run after a
 * UIDVALIDITY change?
 *
 * The date search, in principle, because that is what `since` means. Not
 * every server answers it though: Strato returns zero hits for SINCE, even
 * for periods that demonstrably hold mail. An empty result is therefore no
 * proof that there is nothing — take it as one and you start at UID 1 and
 * work through a decade of archive in steps of 200 before the first current
 * mail arrives.
 *
 * So when the search comes up empty, the last `maxPerRun` messages are
 * fetched by sequence number instead. Every IMAP server can do that, and for
 * a CRM the newest ones are the interesting ones. Older mail stays where it
 * is: there is deliberately no archive import.
 */
async function firstWindow(
  imap: ImapFlow,
  exists: number,
  since: Date,
  maxPerRun: number,
): Promise<string | { uid: string } | null> {
  if (exists === 0) return null

  // search() returns `false` when no mailbox is open — that is an error, not
  // a "nothing found".
  const found = await imap.search({ since }, { uid: true }).catch(() => false as const)

  if (Array.isArray(found) && found.length > 0) {
    // More hits than allowed: the newest win. The rest never follows,
    // because the cursor ends up past them — intended, see above.
    const newest = found.sort((a, b) => a - b).slice(-maxPerRun)
    return { uid: newest.join(',') }
  }

  // Sequence numbers, not UIDs: the last n messages in the folder.
  return `${Math.max(1, exists - maxPerRun + 1)}:${exists}`
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

  // No Message-ID means no reliable duplicate detection — so build one from
  // account, UID and date, and the mail still lands exactly once.
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
    // The text goes into full-text search and into AI matching. 32k
    // characters is more than any seriously meant business letter.
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
