/**
 * Who wins when both devices changed the same thing.
 *
 * The rule is last-writer-wins, decided **per field** rather than per row.
 * Per row would be cheaper and wrong in the case this sync exists for: you
 * tick off an action item in the car while the Mac is writing an AI summary
 * onto the same meeting. Both edits are real, they touch different columns,
 * and a row-level comparison throws one of them away.
 *
 * Per-field LWW normally means storing a timestamp per column — eighty-odd
 * extra columns across nine models. It is not needed here, because the op log
 * already *is* that record: "who last wrote `done` on this action item" is a
 * query over the ops for that row. So the log does double duty and the eight
 * synced models keep their shape.
 *
 * This module is deliberately pure. It decides; syncApply.ts writes. That
 * split is what makes the interesting cases testable without a database.
 */

import { isNewer } from './hlc.js'
import { decodePatch, type Patch } from './syncCodec.js'
import { isSyncEntity, specOf, type SyncEntity } from './syncEntities.js'

export type OpKind = 'upsert' | 'delete'

/** An op as it arrives from another device. */
export type IncomingOp = {
  deviceId: string
  seq: number
  hlc: string
  entity: string
  entityId: string
  op: OpKind
  patch?: unknown
}

/**
 * What the log already holds for one row. Only the three fields the decision
 * needs — the caller selects exactly these, so a hot row stays cheap.
 */
export type KnownOp = {
  hlc: string
  op: OpKind
  fields: string[]
}

export type Decision =
  /** Nothing to do, and why. Surfaced in the push response, not swallowed. */
  | { kind: 'skip'; reason: string }
  | { kind: 'delete' }
  /** `patch` holds only the fields that actually won. */
  | { kind: 'create'; patch: Patch }
  | { kind: 'update'; patch: Patch }

export type DecideInput = {
  incoming: IncomingOp
  /** Every op already logged for this exact row, in any order. */
  known: readonly KnownOp[]
  /** Whether the row is currently in the database. */
  exists: boolean
}

/**
 * The fields some strictly newer op has already written.
 *
 * "Strictly newer" is a string comparison on the HLC - see hlc.ts for why
 * that is a real ordering and not a trick.
 */
function fieldsClaimedByNewer(known: readonly KnownOp[], hlc: string): Set<string> {
  const claimed = new Set<string>()
  for (const op of known) {
    if (!isNewer(op.hlc, hlc)) continue
    for (const field of op.fields) claimed.add(field)
  }
  return claimed
}

function hasNewerDelete(known: readonly KnownOp[], hlc: string): boolean {
  return known.some((op) => op.op === 'delete' && isNewer(op.hlc, hlc))
}

function hasNewerUpsert(known: readonly KnownOp[], hlc: string): boolean {
  return known.some((op) => op.op === 'upsert' && isNewer(op.hlc, hlc))
}

export function decide(input: DecideInput): Decision {
  const { incoming, known, exists } = input

  if (!isSyncEntity(incoming.entity)) {
    return { kind: 'skip', reason: `unbekannte Entitaet ${incoming.entity}` }
  }
  const entity: SyncEntity = incoming.entity

  // --- Delete ------------------------------------------------------------
  if (incoming.op === 'delete') {
    if (!exists) return { kind: 'skip', reason: 'bereits geloescht' }
    // A row edited *after* this delete was made is not deleted: the edit is
    // work, the delete is the absence of it. Keeping the row loses nothing a
    // second delete cannot fix; honouring the delete would throw away an edit
    // nobody can get back. Stated here because it is a choice, not a
    // consequence of the algorithm.
    if (hasNewerUpsert(known, incoming.hlc)) {
      return { kind: 'skip', reason: 'nach dem Loeschen wurde die Zeile geaendert' }
    }
    return { kind: 'delete' }
  }

  // --- Upsert ------------------------------------------------------------
  if (hasNewerDelete(known, incoming.hlc)) {
    return { kind: 'skip', reason: 'Zeile wurde danach geloescht' }
  }

  const decoded = decodePatch(entity, incoming.patch ?? {})
  if (!decoded.ok) return { kind: 'skip', reason: decoded.reason }

  const claimed = fieldsClaimedByNewer(known, incoming.hlc)
  const surviving: Patch = {}
  for (const [field, value] of Object.entries(decoded.patch)) {
    if (claimed.has(field)) continue
    surviving[field] = value
  }

  if (Object.keys(surviving).length === 0) {
    return {
      kind: 'skip',
      reason: exists ? 'jedes Feld lokal neuer' : 'keine verwertbaren Felder',
    }
  }

  if (exists) return { kind: 'update', patch: surviving }

  // Creating needs every non-null column. Normally the first op for a row
  // carries the full row, so this holds; it can fail when a row vanished
  // through a cascade without an op of its own and a later partial edit
  // arrives on its own. Reported rather than guessed at.
  const spec = specOf(entity)
  const missing = spec.required.filter(
    (field) => surviving[field] === undefined || surviving[field] === null,
  )
  if (missing.length > 0) {
    return { kind: 'skip', reason: `Pflichtfelder fehlen: ${missing.join(', ')}` }
  }

  return { kind: 'create', patch: surviving }
}

export function rowKey(entity: string, entityId: string): string {
  return `${entity} ${entityId}`
}

/**
 * Index a flat list of ops by row, so one batch costs one query.
 *
 * A push from the phone after a day offline is hundreds of ops over dozens of
 * rows; asking the database per op would turn that into a visible stall on a
 * phone that is about to lose its Wi-Fi anyway.
 */
export function groupKnownOps(
  rows: readonly { entity: string; entityId: string; hlc: string; op: string; fields: string[] }[],
): Map<string, KnownOp[]> {
  const byRow = new Map<string, KnownOp[]>()
  for (const row of rows) {
    const key = rowKey(row.entity, row.entityId)
    const op: KnownOp = {
      hlc: row.hlc,
      op: row.op === 'delete' ? 'delete' : 'upsert',
      fields: row.fields,
    }
    const list = byRow.get(key)
    if (list) list.push(op)
    else byRow.set(key, [op])
  }
  return byRow
}
