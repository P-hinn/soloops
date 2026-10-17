/**
 * Contracts, as far as soloops is concerned.
 *
 * A contract is a row at the customer plus, where there is one, a PDF in the
 * contract directory. Two ways in: soloops generates one from a template and
 * sends it through n8n and Zoho Sign, or a finished document gets uploaded —
 * the NDA the customer's lawyer wrote, the framework agreement from before
 * soloops existed. Both end up in the same table, because "which contracts do
 * I have with this customer" is one question.
 *
 * What lives here is what has to be right in exactly one place: the file name
 * both the upload and the signing workflow produce, and what a contract's PDF
 * is allowed to be on disk. The path check itself is in services/files.ts,
 * because the files filed at a customer by hand need the same one.
 *
 * The signing workflow cannot import this file — it runs inside n8n as plain
 * JavaScript. `signedFileName` is therefore mirrored in the workflow's
 * "Kontext bauen" node, and the test in apps/web/test/contracts.test.ts holds
 * the two against each other.
 */

import { removeFile, resolveStoredPath, slug, storeFile } from './files.js'

/** Where the PDFs live. Inside /data, a volume the API and n8n share. */
export const SIGNED_ROOT = '/data/vertraege/signiert'

/** A contract is a PDF. The upload checks the bytes too, see `isPdf`. */
const RULES = { extensions: ['.pdf'] } as const

/**
 * Turn a stored file name into a path that may be opened.
 *
 * The value comes out of the database, where an upload and a workflow both
 * write — so this is a security boundary, not a convenience. Anything that
 * does not resolve to a plain PDF directly inside the contract directory
 * comes back as null: traversal, an absolute path somewhere else, a different
 * extension.
 *
 * Symlinks are not followed up on: the directory is written by the workflow
 * and by the upload route, and resolving them would mean a stat before the
 * check.
 */
export function resolveSignedPath(value: string, root = SIGNED_ROOT): string | null {
  return resolveStoredPath(value, { ...RULES, root })
}

/**
 * The name a contract's PDF gets.
 *
 * Flat, with the customer id in front: n8n's write node does not create
 * missing directories (it opens the file with O_CREAT directly), so a folder
 * per customer would be an ENOENT on that customer's first contract.
 *
 * The title is in there for whoever browses the directory, and the unique
 * part at the end — the Zoho request on the way back from signing, the
 * contract id on an upload — is what keeps two contracts of the same name
 * from overwriting each other.
 */
export function signedFileName(input: {
  clientId: string
  title: string
  unique: string
  on: Date
}): string {
  const stamp = input.on.toISOString().slice(0, 10)
  return `${input.clientId}-${stamp}-${slug(input.title, 'vertrag')}-${input.unique}.pdf`
}

// ---------------------------------------------------------------------------
// The directory
//
// Writing and deleting go through here rather than through the route because
// they are the two places the path check has to hold, and because a route
// that calls `writeFile` is a route that cannot be tested without an HTTP
// server. The mechanics are in services/files.ts, which the customer files
// share; what is specific to a contract is that it is a PDF.
// ---------------------------------------------------------------------------

/** The five bytes every PDF starts with. Catches the wrong file, not a liar. */
export function isPdf(bytes: Buffer): boolean {
  return bytes.length > 5 && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))
}

/**
 * Put a PDF into the contract directory.
 *
 * Returns the name it was written under — the same one that went in, which
 * makes the call read as the handover it is. Throws on a name that does not
 * resolve into the directory: that is the boundary, and a caller that built
 * the name itself has a bug rather than bad input.
 */
export async function storeContractFile(
  name: string,
  bytes: Buffer,
  root = SIGNED_ROOT,
): Promise<string> {
  return storeFile(name, bytes, { ...RULES, root })
}

/**
 * Take a PDF out again.
 *
 * Best effort on purpose: a file that is already gone is the state we wanted,
 * and a record that no longer points at a file is what counts. Returns
 * whether something was actually removed, so a caller that cares can log it.
 */
export async function removeContractFile(
  name: string | null | undefined,
  root = SIGNED_ROOT,
): Promise<boolean> {
  return removeFile(name, { ...RULES, root })
}
