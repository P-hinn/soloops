import type { PrismaClient } from '@prisma/client'
import { encodeChanged, encodeRow, type Patch } from './syncCodec.js'
import { DELETE_SIDE_EFFECTS, isSyncEntity, specOf, type SyncEntity } from './syncEntities.js'
import { isApplyingRemote, isReady, recordLocal, type LocalChange } from './syncLog.js'

/**
 * The one place a local write turns into an op.
 *
 * A Prisma client extension rather than a call in every route: there are some
 * thirty write sites across the API, the worker and the MCP server, and a
 * sync that depends on all of them remembering to log is a sync that is
 * already broken. Here it is structurally impossible to write a synced row
 * without the op, which is the only version of this that stays true.
 *
 * Three things the hook has to get right, each of which is a silent data-loss
 * bug if it does not:
 *
 *  - **Narrow patches.** An op claims only the fields the write touched. A
 *    full-row op would claim every column and beat a concurrent edit to an
 *    unrelated field on the other device for no reason. The *values* always
 *    come from the row Prisma returns, never from `args.data`, so atomic
 *    forms like `{ increment: 1 }` and `{ set: [...] }` record what actually
 *    landed.
 *  - **Bulk writes.** `updateMany` and `deleteMany` return a count, not rows,
 *    so the ids are resolved before the write runs.
 *  - **Side effects.** Cascades and `SetNull` happen inside Postgres and
 *    Prisma never reports them. They are declared in syncEntities.ts and
 *    resolved here, before the parent goes away and the children become
 *    unfindable.
 */

/** The models a bulk write may touch, resolved to ids before it runs. */
type PendingBulk = {
  entity: SyncEntity
  ids: string[]
}

type AnyDelegate = {
  findMany: (args: unknown) => Promise<{ id: string }[]>
}

function delegate(client: PrismaClient, entity: SyncEntity): AnyDelegate {
  const model = specOf(entity).model
  return (client as unknown as Record<string, AnyDelegate>)[model] as AnyDelegate
}

/**
 * Everything a delete of these rows will also change, as ops.
 *
 * Resolved before the delete, because afterwards the foreign keys are gone
 * and there is no way back to the affected children.
 */
async function sideEffectsOf(
  client: PrismaClient,
  entity: SyncEntity,
  ids: readonly string[],
): Promise<LocalChange[]> {
  const effects = DELETE_SIDE_EFFECTS[entity]
  if (effects.length === 0 || ids.length === 0) return []

  const changes: LocalChange[] = []

  for (const effect of effects) {
    const rows = await delegate(client, effect.entity).findMany({
      where: { [effect.fk]: { in: [...ids] } },
      select: { id: true },
    })
    for (const row of rows) {
      if (effect.kind === 'delete') {
        changes.push({
          entity: effect.entity,
          entityId: row.id,
          op: 'delete',
          patch: null,
          fields: [],
        })
      } else {
        // The row survives with the reference cleared. Recording it as a
        // one-field patch is exactly right: only `clientId` changed, so only
        // `clientId` is claimed, and a concurrent title edit on the phone
        // still wins.
        changes.push({
          entity: effect.entity,
          entityId: row.id,
          op: 'upsert',
          patch: { [effect.fk]: null },
          fields: [effect.fk],
        })
      }
    }
  }

  return changes
}

/** The fields a write claims, from the shape of `args.data`. */
function touchedFields(entity: SyncEntity, data: unknown): string[] {
  if (data === null || typeof data !== 'object') return []
  const spec = specOf(entity)
  return Object.keys(data as Patch).filter((key) =>
    Object.prototype.hasOwnProperty.call(spec.fields, key),
  )
}

async function idsMatching(
  client: PrismaClient,
  entity: SyncEntity,
  where: unknown,
): Promise<string[]> {
  const rows = await delegate(client, entity).findMany({ where, select: { id: true } })
  return rows.map((row) => row.id)
}

type HookArgs = {
  model?: string
  operation: string
  args: Record<string, unknown>
  query: (args: unknown) => Promise<unknown>
}

/**
 * Wrap a client so every write to a synced model appends to the log.
 *
 * The returned client is used everywhere `prisma` was used before; the hook
 * is transparent for reads and for models that do not sync.
 */
export function withSyncLog(base: PrismaClient): PrismaClient {
  // The un-extended client is used for the hook's own bookkeeping queries.
  // Going through the extended one would recurse through this same hook.
  const raw = base

  const extended = base.$extends({
    name: 'soloops-sync-log',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: HookArgs) {
          if (!model || !isSyncEntity(model) || !isReady() || isApplyingRemote()) {
            return query(args)
          }
          const entity: SyncEntity = model

          switch (operation) {
            case 'create': {
              const row = (await query(args)) as Record<string, unknown>
              // A new row conflicts with nothing, so claiming all of it is
              // both correct and what a fresh device needs to see.
              const patch = encodeRow(entity, row)
              await recordLocal([
                {
                  entity,
                  entityId: String(row.id),
                  op: 'upsert',
                  patch,
                  fields: Object.keys(patch),
                },
              ])
              return row
            }

            case 'update': {
              const fields = touchedFields(entity, args.data)
              const row = (await query(args)) as Record<string, unknown>
              if (fields.length === 0) return row
              await recordLocal([
                {
                  entity,
                  entityId: String(row.id),
                  op: 'upsert',
                  patch: encodeChanged(entity, row, fields),
                  fields,
                },
              ])
              return row
            }

            case 'upsert': {
              const row = (await query(args)) as Record<string, unknown>
              // Prisma does not say whether it created or updated, so this
              // claims the whole row. No synced model is written this way
              // today; the branch exists so that adding such a call site
              // cannot produce an unlogged write.
              const patch = encodeRow(entity, row)
              await recordLocal([
                {
                  entity,
                  entityId: String(row.id),
                  op: 'upsert',
                  patch,
                  fields: Object.keys(patch),
                },
              ])
              return row
            }

            case 'delete': {
              const ids = await idsMatching(raw, entity, args.where)
              const effects = await sideEffectsOf(raw, entity, ids)
              const row = await query(args)
              await recordLocal([
                ...effects,
                ...ids.map((id): LocalChange => ({
                  entity,
                  entityId: id,
                  op: 'delete',
                  patch: null,
                  fields: [],
                })),
              ])
              return row
            }

            case 'deleteMany': {
              const ids = await idsMatching(raw, entity, args.where)
              const effects = await sideEffectsOf(raw, entity, ids)
              const result = await query(args)
              await recordLocal([
                ...effects,
                ...ids.map((id): LocalChange => ({
                  entity,
                  entityId: id,
                  op: 'delete',
                  patch: null,
                  fields: [],
                })),
              ])
              return result
            }

            case 'updateMany': {
              const fields = touchedFields(entity, args.data)
              const pending: PendingBulk = {
                entity,
                ids: fields.length > 0 ? await idsMatching(raw, entity, args.where) : [],
              }
              const result = await query(args)
              if (pending.ids.length === 0) return result

              // Read the rows back for their values: `args.data` may hold
              // atomic operations, and the op has to carry what landed.
              const rows = (await delegate(raw, entity).findMany({
                where: { id: { in: pending.ids } },
              })) as unknown as Record<string, unknown>[]

              await recordLocal(
                rows.map((row): LocalChange => ({
                  entity,
                  entityId: String(row.id),
                  op: 'upsert',
                  patch: encodeChanged(entity, row, fields),
                  fields,
                })),
              )
              return result
            }

            case 'createMany':
            case 'createManyAndReturn': {
              // `createMany` reports a count, and the generated ids are not
              // recoverable afterwards without guessing from timestamps.
              // Rather than log something approximate, this refuses: the
              // alternative is a sync with occasional invisible holes, and
              // there is exactly one call site, in ai/digest.ts.
              throw new Error(
                `${entity}: createMany kann nicht protokolliert werden — ` +
                  'einzelne create-Aufrufe in einer $transaction verwenden',
              )
            }

            default:
              return query(args)
          }
        },
      },
    },
  })

  return extended as unknown as PrismaClient
}
