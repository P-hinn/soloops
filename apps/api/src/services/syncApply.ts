import { Prisma } from '@prisma/client'
import { dbRaw, prisma } from '../db.js'
import { parse as parseHlc } from './hlc.js'
import type { Patch } from './syncCodec.js'
import { isSyncEntity, specOf, type SyncEntity } from './syncEntities.js'
import { decide, groupKnownOps, rowKey, type IncomingOp, type KnownOp } from './syncMerge.js'
import { asRemote, recordRemote, type RecordedOp } from './syncLog.js'

/**
 * Applying ops that came from another device.
 *
 * The decision is in syncMerge.ts; this is the part that touches the
 * database, and its job is mostly to not make the easy mistakes:
 *
 *  - **Every op is logged, applied or not.** A rejected op is still part of
 *    the shared history, and the log is what the field-level merge reads to
 *    decide the *next* conflict. Dropping the losers would make the two
 *    devices disagree about who last wrote a field.
 *  - **Writes run under the origin's identity**, so the op does not come back
 *    as a local change and bounce between the devices forever.
 *  - **One bad op does not stop the batch.** A phone that has been offline
 *    for a day pushes everything at once, and a single row referring to a
 *    project that no longer exists must not hold up the other two hundred.
 */

export type ApplyStatus = 'applied' | 'skipped' | 'failed'

export type ApplyResult = {
  deviceId: string
  seq: number
  status: ApplyStatus
  reason?: string
}

type RowState = {
  known: KnownOp[]
  exists: boolean
}

function delegateFor(entity: SyncEntity) {
  const model = specOf(entity).model
  return (prisma as unknown as Record<string, Record<string, (args: unknown) => Promise<unknown>>>)[
    model
  ]!
}

/**
 * Load the log and the row existence for every row the batch touches, in one
 * query per entity instead of two per op.
 */
async function loadState(ops: readonly IncomingOp[]): Promise<Map<string, RowState>> {
  const idsByEntity = new Map<SyncEntity, Set<string>>()
  for (const op of ops) {
    if (!isSyncEntity(op.entity)) continue
    const set = idsByEntity.get(op.entity) ?? new Set<string>()
    set.add(op.entityId)
    idsByEntity.set(op.entity, set)
  }

  const state = new Map<string, RowState>()

  for (const [entity, idSet] of idsByEntity) {
    const ids = [...idSet]

    const logRows = await dbRaw.syncOp.findMany({
      where: { entity, entityId: { in: ids } },
      select: { entity: true, entityId: true, hlc: true, op: true, fields: true },
    })
    const grouped = groupKnownOps(logRows)

    const existing = (await delegateFor(entity).findMany!({
      where: { id: { in: ids } },
      select: { id: true },
    })) as { id: string }[]
    const present = new Set(existing.map((row) => row.id))

    for (const id of ids) {
      const key = rowKey(entity, id)
      state.set(key, { known: grouped.get(key) ?? [], exists: present.has(id) })
    }
  }

  return state
}

/** The op as it will be stored — the origin's identity, verbatim. */
function toRecorded(op: IncomingOp, entity: SyncEntity): RecordedOp {
  return {
    deviceId: op.deviceId,
    seq: op.seq,
    hlc: op.hlc,
    entity,
    entityId: op.entityId,
    op: op.op,
    patch: (op.patch as Patch | undefined) ?? null,
    fields:
      op.op === 'delete' || op.patch === null || typeof op.patch !== 'object'
        ? []
        : Object.keys(op.patch as Patch).filter((key) =>
            Object.prototype.hasOwnProperty.call(specOf(entity).fields, key),
          ),
  }
}

function describeWriteError(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2003 is a foreign key the other device has and this one does not;
    // P2002 a unique column, which for us means a `Project.key` collision.
    if (err.code === 'P2003') return 'Verweis zeigt auf eine Zeile, die hier nicht existiert'
    if (err.code === 'P2002') return 'Eindeutiges Feld kollidiert mit einer bestehenden Zeile'
    if (err.code === 'P2025') return 'Zeile nicht gefunden'
    return `Datenbankfehler ${err.code}`
  }
  return err instanceof Error ? err.message : 'unbekannter Fehler'
}

/**
 * Apply one batch.
 *
 * Ops are applied in HLC order, which is the order they happened in, so a
 * parent generally arrives before the child that points at it. Generally is
 * not always — the phone may have created both inside one millisecond and
 * pushed them in either order — so ops that fail on a foreign key get one
 * second pass once the rest of the batch is in.
 */
export async function applyOps(incoming: readonly IncomingOp[]): Promise<ApplyResult[]> {
  if (incoming.length === 0) return []

  const ordered = [...incoming].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))
  const state = await loadState(ordered)
  const results = new Map<string, ApplyResult>()
  const retry: IncomingOp[] = []

  const resultKey = (op: IncomingOp) => `${op.deviceId}#${op.seq}`

  // Which of these ops this machine has already seen, read once up front.
  // The iCloud transport has no delivery receipt, so a batch the phone wrote
  // before losing signal gets read again in full. Re-applying is harmless —
  // the values are the same — but reporting it as `applied` would tell the
  // phone it had just won a merge it never fought, and the write itself is
  // waste. The snapshot is taken before anything is recorded so that the
  // second pass below does not mistake this batch's own ops for old ones.
  const seen = new Set(
    (
      await dbRaw.syncOp.findMany({
        where: {
          OR: ordered.map((op) => ({ deviceId: op.deviceId, seq: op.seq })),
        },
        select: { deviceId: true, seq: true },
      })
    ).map((row) => `${row.deviceId}#${row.seq}`),
  )

  const run = async (op: IncomingOp, isRetry: boolean): Promise<void> => {
    const key = resultKey(op)

    if (!isRetry && seen.has(key)) {
      results.set(key, {
        deviceId: op.deviceId,
        seq: op.seq,
        status: 'skipped',
        reason: 'bereits verarbeitet',
      })
      return
    }

    if (!parseHlc(op.hlc)) {
      results.set(key, {
        deviceId: op.deviceId,
        seq: op.seq,
        status: 'failed',
        reason: 'ungueltiger HLC-Zeitstempel',
      })
      return
    }
    if (!isSyncEntity(op.entity)) {
      results.set(key, {
        deviceId: op.deviceId,
        seq: op.seq,
        status: 'skipped',
        reason: `unbekannte Entitaet ${op.entity}`,
      })
      return
    }
    const entity: SyncEntity = op.entity
    const recorded = toRecorded(op, entity)
    const rKey = rowKey(entity, op.entityId)
    const row = state.get(rKey) ?? { known: [], exists: false }

    const decision = decide({ incoming: op, known: row.known, exists: row.exists })

    // The op joins the history either way — see the note at the top. Only on
    // the first attempt: a retry has already been recorded, and writing it
    // again would hit the unique constraint and fill the log with errors for
    // the expected case.
    if (!isRetry) {
      await recordRemote(recorded)
      row.known.push({ hlc: recorded.hlc, op: recorded.op, fields: recorded.fields })
      state.set(rKey, row)
    }

    if (decision.kind === 'skip') {
      results.set(key, {
        deviceId: op.deviceId,
        seq: op.seq,
        status: 'skipped',
        reason: decision.reason,
      })
      return
    }

    const delegate = delegateFor(entity)

    try {
      await asRemote(recorded, async () => {
        if (decision.kind === 'delete') {
          await delegate.delete!({ where: { id: op.entityId } })
        } else if (decision.kind === 'create') {
          await delegate.create!({ data: { id: op.entityId, ...decision.patch } })
        } else {
          await delegate.update!({ where: { id: op.entityId }, data: decision.patch })
        }
      })
    } catch (err) {
      const reason = describeWriteError(err)
      const foreignKey = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003'
      if (foreignKey && !isRetry) {
        retry.push(op)
        return
      }
      results.set(key, { deviceId: op.deviceId, seq: op.seq, status: 'failed', reason })
      return
    }

    row.exists = decision.kind !== 'delete'
    state.set(rKey, row)
    results.set(key, { deviceId: op.deviceId, seq: op.seq, status: 'applied' })
  }

  for (const op of ordered) await run(op, false)
  // Second pass for the ones whose parent arrived later in the same batch.
  for (const op of retry) await run(op, true)

  return ordered.map(
    (op) =>
      results.get(resultKey(op)) ?? {
        deviceId: op.deviceId,
        seq: op.seq,
        status: 'failed' as ApplyStatus,
        reason: 'nicht verarbeitet',
      },
  )
}
