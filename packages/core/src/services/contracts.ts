/**
 * Contracts, as far as soloops is concerned.
 *
 * The signing itself happens in n8n and Zoho Sign. What stays here is the
 * record of it, and that record is deliberately not a table: a contract is a
 * note on the customer with a `[VERTRAG]` prefix, plus a task while the
 * signature is outstanding. Both already sync to the phone, both already show
 * up in search, and neither needs a migration when the next contract type
 * appears.
 *
 * The convention is therefore load-bearing, which is why parsing it lives in
 * one place with tests rather than in a view:
 *
 *     [VERTRAG] <Titel> – versendet 12.10.2026 – Zoho-ID: abc123
 *     [VERTRAG] <Titel> – signiert 20.10.2026 – Datei: <pfad>
 */

import { isAbsolute, join, normalize, resolve } from 'node:path'

export const CONTRACT_PREFIX = '[VERTRAG]'

/** Where the signed PDFs live. Inside /data, a volume the API and n8n share. */
export const SIGNED_ROOT = '/data/vertraege/signiert'

/**
 * Turn the `Datei:` of a note into a path that may be opened.
 *
 * The value comes out of a note, and a note is editable by hand — so this is
 * a security boundary, not a convenience. Anything that does not resolve to a
 * plain PDF directly inside the contract directory comes back as null:
 * traversal, an absolute path somewhere else, a different extension.
 *
 * Symlinks are not followed up on: the directory is written by the workflow
 * and by nothing else, and resolving them would mean a stat before the check.
 */
export function resolveSignedPath(value: string, root = SIGNED_ROOT): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return null

  const full = resolve(isAbsolute(trimmed) ? normalize(trimmed) : join(root, normalize(trimmed)))
  if (!full.startsWith(`${root}/`)) return null
  if (!full.toLowerCase().endsWith('.pdf')) return null
  // One directory deep at most — the workflow writes flat into the root.
  if (full.slice(root.length + 1).includes('/')) return null
  return full
}

/** The four types the templates cover. The wire values the webhook expects. */
export const CONTRACT_TYPES = ['nda', 'werkvertrag', 'dienstvertrag', 'freie-mitarbeit'] as const

export type ContractType = (typeof CONTRACT_TYPES)[number]

export type ContractStatus = 'versendet' | 'signiert' | 'abgelehnt'

export type ParsedContractNote = {
  title: string
  status: ContractStatus
  /** The date as written in the note, ISO where it could be read. */
  on: string | null
  zohoRequestId: string | null
  /** Where the signed PDF landed, relative to /data. */
  file: string | null
}

const STATUS: Record<string, ContractStatus> = {
  versendet: 'versendet',
  signiert: 'signiert',
  abgelehnt: 'abgelehnt',
}

/**
 * Read one note title back into its parts.
 *
 * Forgiving on purpose: the parts are separated by en dashes typed by a
 * workflow, and a note somebody edited by hand should still show up in the
 * overview with whatever could be read from it, rather than vanish.
 */
export function parseContractNote(title: string): ParsedContractNote | null {
  if (!title.startsWith(CONTRACT_PREFIX)) return null
  const rest = title.slice(CONTRACT_PREFIX.length).trim()
  if (!rest) return null

  const parts = rest.split(/\s+[–—-]\s+/)
  const name = parts[0]?.trim() ?? ''
  if (!name) return null

  let status: ContractStatus = 'versendet'
  let on: string | null = null
  let zohoRequestId: string | null = null
  let file: string | null = null

  for (const part of parts.slice(1)) {
    const segment = part.trim()
    const stateMatch = /^(versendet|signiert|abgelehnt)\b\s*(.*)$/i.exec(segment)
    if (stateMatch) {
      status = STATUS[stateMatch[1]!.toLowerCase()] ?? 'versendet'
      on = toIsoDate(stateMatch[2]!.trim()) ?? on
      continue
    }
    const idMatch = /^Zoho-ID:\s*(\S+)$/i.exec(segment)
    if (idMatch) {
      zohoRequestId = idMatch[1]!
      continue
    }
    const fileMatch = /^Datei:\s*(\S+)$/i.exec(segment)
    if (fileMatch) file = fileMatch[1]!
  }

  return { title: name, status, on, zohoRequestId, file }
}

/** `12.10.2026` or an ISO date; anything else stays null rather than guessing. */
function toIsoDate(value: string): string | null {
  if (!value) return null
  const german = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(value)
  if (german) {
    const [, d, m, y] = german
    return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  }
  const iso = /^\d{4}-\d{2}-\d{2}/.exec(value)
  return iso ? iso[0]! : null
}

/** How a workflow should write the note. Kept next to the parser on purpose. */
export function contractNoteTitle(input: {
  title: string
  status: ContractStatus
  on: Date
  zohoRequestId?: string | null
  file?: string | null
}): string {
  const date = input.on.toLocaleDateString('de-DE')
  const parts = [`${CONTRACT_PREFIX} ${input.title}`, `${input.status} ${date}`]
  if (input.zohoRequestId) parts.push(`Zoho-ID: ${input.zohoRequestId}`)
  if (input.file) parts.push(`Datei: ${input.file}`)
  return parts.join(' – ')
}

/**
 * One row of the overview: the newest state per contract.
 *
 * A contract produces two notes — sent, then signed — and the overview wants
 * one line. They are joined on the Zoho request id where there is one, and on
 * the title where there is not, because a note written by hand has no id.
 */
export function foldContractNotes<T extends { id: string; createdAt: Date }>(
  notes: (T & { parsed: ParsedContractNote })[],
): (ParsedContractNote & { noteId: string; createdAt: Date; sentOn: string | null })[] {
  const rows = new Map<
    string,
    ParsedContractNote & { noteId: string; createdAt: Date; sentOn: string | null }
  >()

  for (const note of [...notes].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const key = note.parsed.zohoRequestId ?? note.parsed.title
    const previous = rows.get(key)
    rows.set(key, {
      ...note.parsed,
      // The sent date survives the signed note, which does not repeat it.
      sentOn: previous?.sentOn ?? (note.parsed.status === 'versendet' ? note.parsed.on : null),
      zohoRequestId: note.parsed.zohoRequestId ?? previous?.zohoRequestId ?? null,
      file: note.parsed.file ?? previous?.file ?? null,
      noteId: note.id,
      createdAt: previous?.createdAt ?? note.createdAt,
    })
  }

  return [...rows.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

// ---------------------------------------------------------------------------
// The overview
// ---------------------------------------------------------------------------

/** A `[VERTRAG]` note as the overview needs it. */
export type ContractNoteInput = {
  id: string
  title: string
  createdAt: Date
  clientId: string | null
  client: { id: string; name: string; company: string | null } | null
}

/** An open "Signatur ausstehend" task, waiting to be matched to a contract. */
export type SignatureTaskInput = {
  id: string
  title: string
  dueOn: Date | null
  clientId: string | null
}

export type ContractRow = ParsedContractNote & {
  noteId: string
  createdAt: Date
  sentOn: string | null
  clientId: string | null
  client: ContractNoteInput['client']
  openTask: SignatureTaskInput | null
}

/**
 * Notes and open tasks into one row per contract.
 *
 * Grouped per customer first: two customers can have a contract of the same
 * name, and the fold joins on the title where there is no Zoho id.
 *
 * The open task is matched by title, which is all the workflow wrote — and
 * each task is handed out **once**. Two identical contracts for the same
 * customer are indistinguishable from their titles, so without that the same
 * "Signatur ausstehend" would appear on both rows and one of them would be a
 * lie. The older row gets it: it is the one that has been waiting longer.
 */
export function buildContractRows(
  notes: readonly ContractNoteInput[],
  openTasks: readonly SignatureTaskInput[],
): ContractRow[] {
  const byClient = new Map<string, ContractNoteInput[]>()
  for (const note of notes) {
    const key = note.clientId ?? ''
    byClient.set(key, [...(byClient.get(key) ?? []), note])
  }

  const rows: ContractRow[] = []

  for (const [clientId, clientNotes] of byClient) {
    const parsed = clientNotes.flatMap((note) => {
      const result = parseContractNote(note.title)
      return result ? [{ ...note, parsed: result }] : []
    })

    for (const folded of foldContractNotes(parsed)) {
      rows.push({
        ...folded,
        clientId: clientId || null,
        client: clientNotes[0]?.client ?? null,
        openTask: null,
      })
    }
  }

  rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

  // Oldest first while claiming, so a task goes to the contract that has been
  // waiting longest; the rows themselves stay newest first.
  const claimed = new Set<string>()
  for (const row of [...rows].reverse()) {
    const task = openTasks.find(
      (candidate) =>
        !claimed.has(candidate.id) &&
        (candidate.clientId ?? null) === row.clientId &&
        candidate.title.includes(row.title),
    )
    if (!task) continue
    claimed.add(task.id)
    row.openTask = task
  }

  return rows
}
