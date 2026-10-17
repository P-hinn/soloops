/**
 * Files on the disk next to the database.
 *
 * Two kinds live there — the signed contract PDFs and the files filed at a
 * customer by hand — and both need the same two things: a name built out of
 * data rather than taken from a request, and a check that turns a stored name
 * back into a path that may be opened. The second one is a security boundary:
 * the names come out of the database, where an upload and an n8n workflow
 * both write.
 *
 * It lives here rather than in either service because a path check that
 * exists twice is a path check that is right once.
 */

import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'

/**
 * Where a kind of file lives, and what it may be.
 *
 * `extensions` are lower-case and include the dot. Left out, any extension
 * passes — which is what the customer files need: a briefing is a PDF, a logo
 * is an SVG and the thing from the tax advisor is a ZIP.
 */
export type FileRules = {
  root: string
  extensions?: readonly string[]
}

/**
 * Turn a stored file name into a path that may be opened, or null.
 *
 * Anything that does not resolve to a plain file directly inside the
 * directory comes back as null: traversal, an absolute path somewhere else, a
 * sub-directory, an extension the kind does not allow. Null means "do not
 * touch this", never "try harder".
 *
 * Symlinks are not followed up on: the directories are written by this
 * codebase and by the signing workflow, and resolving them would mean a stat
 * before the check.
 */
export function resolveStoredPath(value: string, rules: FileRules): string | null {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('\0')) return null

  const root = rules.root.replace(/\/+$/, '')
  const full = resolve(isAbsolute(trimmed) ? normalize(trimmed) : join(root, normalize(trimmed)))
  if (!full.startsWith(`${root}/`)) return null

  const name = full.slice(root.length + 1)
  // One directory deep at most — the directories are flat.
  if (name.includes('/')) return null
  if (rules.extensions && !rules.extensions.some((ext) => name.toLowerCase().endsWith(ext))) {
    return null
  }
  return full
}

/**
 * Put bytes into a file directory.
 *
 * Returns the name they were written under — the same one that went in, which
 * makes the call read as the handover it is. Throws on a name that does not
 * resolve into the directory: that is the boundary, and a caller that built
 * the name itself has a bug rather than bad input.
 */
export async function storeFile(name: string, bytes: Buffer, rules: FileRules): Promise<string> {
  const target = resolveStoredPath(name, rules)
  if (!target) throw new Error(`Dateiname nicht zulässig: ${name}`)

  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return name
}

/**
 * Take a file out again.
 *
 * Best effort on purpose: a file that is already gone is the state we wanted,
 * and a record that no longer points at a file is what counts. Returns
 * whether something was actually removed, so a caller that cares can log it.
 */
export async function removeFile(
  name: string | null | undefined,
  rules: FileRules,
): Promise<boolean> {
  if (!name) return false
  const target = resolveStoredPath(name, rules)
  if (!target) return false
  try {
    await unlink(target)
    return true
  } catch {
    // Missing, or a directory somebody made read-only.
    return false
  }
}

/**
 * A title as a file name part: letters, digits and dashes.
 *
 * Everything else is somebody else's problem. Long enough to recognise, short
 * enough to leave room for the rest of the name inside a file system's 255
 * bytes.
 */
export function slug(title: string, fallback: string): string {
  const cleaned = title
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned.slice(0, 60) || fallback
}
