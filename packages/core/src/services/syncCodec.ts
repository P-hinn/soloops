/**
 * Between Prisma rows and the JSON an op carries.
 *
 * The phone speaks JSON, Prisma wants `Date` objects and real numbers, and a
 * `DateTime` column handed a string throws at the query layer with a message
 * nobody can act on. So every value crosses this boundary explicitly, and a
 * value that cannot cross is reported rather than coerced into something
 * plausible — a date that silently becomes `Invalid Date` would be written to
 * the row and corrupt it.
 */

import { type FieldKind, type SyncEntity, specOf } from './syncEntities.js'

export type Patch = Record<string, unknown>

export type DecodeResult = { ok: true; value: unknown } | { ok: false; reason: string }

function decodeDate(value: unknown): DecodeResult {
  if (typeof value === 'number') {
    const date = new Date(value)
    return Number.isNaN(date.getTime())
      ? { ok: false, reason: 'ungültiger Zeitstempel' }
      : { ok: true, value: date }
  }
  if (typeof value !== 'string') return { ok: false, reason: 'Datum erwartet' }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? { ok: false, reason: 'ungültiges Datum' }
    : { ok: true, value: date }
}

/** One field, from JSON into what Prisma accepts. */
export function decodeField(kind: FieldKind, value: unknown): DecodeResult {
  if (value === null || value === undefined) {
    // Null is a real value here: clearing a follow-up date is an edit.
    return { ok: true, value: null }
  }

  switch (kind) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, reason: 'Text erwartet' }

    case 'int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, reason: 'Ganzzahl erwartet' }
      }
      return { ok: true, value }
    }

    case 'bool':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, reason: 'Boolean erwartet' }

    case 'date':
      return decodeDate(value)

    case 'strings': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        return { ok: false, reason: 'Liste von Texten erwartet' }
      }
      return { ok: true, value }
    }

    case 'dates': {
      if (!Array.isArray(value)) return { ok: false, reason: 'Liste von Daten erwartet' }
      const dates: Date[] = []
      for (const entry of value) {
        const decoded = decodeDate(entry)
        if (!decoded.ok) return decoded
        if (decoded.value !== null) dates.push(decoded.value as Date)
      }
      return { ok: true, value: dates }
    }

    case 'json':
      // Whatever the column already accepts. `decisions` is a string[] today
      // and validating it here would duplicate the route's schema.
      return { ok: true, value }
  }
}

export type DecodedPatch =
  { ok: true; patch: Patch; unknownFields: string[] } | { ok: false; reason: string }

/**
 * A whole patch. Unknown keys are dropped rather than rejected: a newer phone
 * build may well sync a field this API does not have yet, and refusing the
 * entire op would stall that row forever.
 */
export function decodePatch(entity: SyncEntity, raw: unknown): DecodedPatch {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'patch muss ein Objekt sein' }
  }

  const spec = specOf(entity)
  const patch: Patch = {}
  const unknownFields: string[] = []

  for (const [key, value] of Object.entries(raw as Patch)) {
    const kind = spec.fields[key as keyof typeof spec.fields] as FieldKind | undefined
    if (!kind) {
      unknownFields.push(key)
      continue
    }
    const decoded = decodeField(kind, value)
    if (!decoded.ok) return { ok: false, reason: `${key}: ${decoded.reason}` }
    patch[key] = decoded.value
  }

  return { ok: true, patch, unknownFields }
}

/** One field, on its way out to JSON. */
export function encodeField(kind: FieldKind, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (kind === 'date') return value instanceof Date ? value.toISOString() : value
  if (kind === 'dates') {
    return Array.isArray(value) ? value.map((v) => (v instanceof Date ? v.toISOString() : v)) : []
  }
  return value
}

/**
 * The syncable part of a Prisma row, as JSON.
 *
 * Used both for the op the write hook records and for the snapshot a fresh
 * device starts from, so that both sides go through the same filter.
 */
export function encodeRow(entity: SyncEntity, row: Record<string, unknown>): Patch {
  const spec = specOf(entity)
  const out: Patch = {}
  for (const [field, kind] of Object.entries(spec.fields) as [string, FieldKind][]) {
    if (!(field in row)) continue
    out[field] = encodeField(kind, row[field])
  }
  return out
}

/**
 * The same, but only the fields a write actually touched.
 *
 * Narrow patches are what make field-level merging possible: an op that
 * carries the whole row claims every field, and a concurrent edit to an
 * unrelated field on the other device would lose for no reason.
 */
export function encodeChanged(
  entity: SyncEntity,
  row: Record<string, unknown>,
  touched: Iterable<string>,
): Patch {
  const spec = specOf(entity)
  const out: Patch = {}
  for (const field of touched) {
    const kind = spec.fields[field as keyof typeof spec.fields] as FieldKind | undefined
    if (!kind || !(field in row)) continue
    out[field] = encodeField(kind, row[field])
  }
  return out
}
