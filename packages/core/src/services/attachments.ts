/**
 * Files filed at a customer by hand, on disk.
 *
 * Everything that is not a contract: the briefing, the logo the customer
 * sent, the scan of a handover protocol, the invoice from the subcontractor.
 * soloops knows nothing about what is inside them — it keeps the bytes, the
 * name they arrived under and which customer they belong to, which is what
 * makes "send me the thing from back then" a question with an answer.
 *
 * What lives here is the directory and the name a file is stored under. The
 * rules both the API and the interface need — the name a download is offered
 * under, which types may be rendered in place — are in @soloops/shared.
 */

import { extensionOf } from '@soloops/shared'
import { removeFile, resolveStoredPath, slug, storeFile } from './files.js'

/** Where they live. Inside /data, next to the contract directory. */
export const FILE_ROOT = '/data/dateien'

/**
 * Anything, as far as the extension goes.
 *
 * A contract is a PDF and the upload checks the bytes; a customer file is
 * whatever the customer sent, and a list of allowed extensions would be a
 * list that is wrong the first time somebody gets a .heic. The protection is
 * elsewhere: the name is built here rather than taken from the request, and
 * nothing that could run in a browser is served in place — see `isInlineSafe`
 * in @soloops/shared.
 */
const RULES = {} as const

/**
 * Turn a stored file name into a path that may be opened.
 *
 * Same boundary as the contracts' one, minus the extension: the value comes
 * out of the database and anything that does not resolve to a plain file
 * directly inside the file directory comes back as null.
 */
export function resolveAttachmentPath(value: string, root = FILE_ROOT): string | null {
  return resolveStoredPath(value, { ...RULES, root })
}

/**
 * The name a file is stored under.
 *
 * Built out of the customer, the day and the attachment's own id — never out
 * of what the browser sent, which is a name somebody can choose. The id at
 * the end is what keeps two files of the same name from overwriting each
 * other; the readable part in the middle is for whoever browses the directory
 * with a file manager.
 *
 * The extension is the one piece taken from the uploaded name, because it is
 * what makes a file open with a double click. It is sanitised to letters and
 * digits and dropped entirely when it is not one.
 */
export function attachmentFileName(input: {
  clientId: string
  name: string
  unique: string
  on: Date
}): string {
  const stamp = input.on.toISOString().slice(0, 10)
  const ext = extensionOf(input.name)
  const base = ext ? input.name.trim().slice(0, -ext.length) : input.name
  return `${input.clientId}-${stamp}-${slug(base, 'datei')}-${input.unique}${ext}`
}

/**
 * Put bytes into the file directory. Throws on a name that does not resolve
 * into it, which is a bug in the caller rather than bad input.
 */
export async function storeAttachmentFile(
  name: string,
  bytes: Buffer,
  root = FILE_ROOT,
): Promise<string> {
  return storeFile(name, bytes, { ...RULES, root })
}

/** Take a file out again. Best effort: already gone is the state we wanted. */
export async function removeAttachmentFile(
  name: string | null | undefined,
  root = FILE_ROOT,
): Promise<boolean> {
  return removeFile(name, { ...RULES, root })
}
