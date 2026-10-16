import { randomUUID } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { configureSyncLog, initSyncLog, type RecordedOp } from './services/syncLog.js'
import { withSyncLog } from './services/syncHook.js'

/**
 * The un-extended client.
 *
 * Only the sync log's own bookkeeping uses this. Everything else goes through
 * `prisma` below, so that a write to a synced model cannot happen without its
 * op — see services/syncHook.ts.
 */
const base = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

export const prisma = withSyncLog(base)

/**
 * Full-text search for notes, meetings and mail. Prisma has no notion of
 * tsvector, so the GIN indexes are created once at startup.
 */
export async function ensureSearchIndexes(): Promise<void> {
  const statements = [
    `CREATE INDEX IF NOT EXISTS note_fts_idx ON "Note"
       USING GIN (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(body,'')))`,
    `CREATE INDEX IF NOT EXISTS meeting_fts_idx ON "Meeting"
       USING GIN (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(minutes,'')))`,
    `CREATE INDEX IF NOT EXISTS mail_fts_idx ON "MailMessage"
       USING GIN (to_tsvector('german', coalesce(subject,'') || ' ' || coalesce("bodyText",'')))`,
    `CREATE INDEX IF NOT EXISTS lead_fts_idx ON "Lead"
       USING GIN (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(company,'') || ' ' || coalesce(notes,'')))`,
  ]
  for (const sql of statements) {
    try {
      await base.$executeRawUnsafe(sql)
    } catch (err) {
      console.warn('[db] Index konnte nicht angelegt werden:', (err as Error).message)
    }
  }
}

/**
 * Bring the op log up.
 *
 * `role` separates the processes that write on this machine. The API and the
 * worker are both "the Mac" to the phone, but they mint sequence numbers
 * independently, and a shared device id would have them collide on
 * `(deviceId, seq)` the first time a digest run and a request overlap. Two
 * identities cost nothing and make that impossible.
 */
export async function initSync(role: 'api' | 'worker'): Promise<{ deviceId: string }> {
  const settingKey = role === 'api' ? 'sync.deviceId' : `sync.deviceId.${role}`

  configureSyncLog({
    deviceIdKey: settingKey,
    newId: () => randomUUID(),

    getSetting: async (key) => {
      const row = await base.appSetting.findUnique({ where: { key } })
      return typeof row?.value === 'string' ? row.value : null
    },

    setSetting: async (key, value) => {
      await base.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
    },

    registerHost: async (deviceId) => {
      await base.syncDevice.upsert({
        where: { id: deviceId },
        create: {
          id: deviceId,
          name: role === 'api' ? 'Mac (API)' : 'Mac (Worker)',
          platform: 'macos',
          // No token: this process does not authenticate against itself.
          tokenHash: null,
        },
        update: { lastSeenAt: new Date() },
      })
    },

    newestHlc: async () => {
      const row = await base.syncOp.findFirst({
        orderBy: { hlc: 'desc' },
        select: { hlc: true },
      })
      return row?.hlc ?? null
    },

    nextSeq: async (deviceId) => {
      const result = await base.syncOp.aggregate({
        where: { deviceId },
        _max: { seq: true },
      })
      return (result._max.seq ?? 0) + 1
    },

    insert: async (op: RecordedOp) => {
      try {
        await base.syncOp.create({
          data: {
            deviceId: op.deviceId,
            seq: op.seq,
            hlc: op.hlc,
            entity: op.entity,
            entityId: op.entityId,
            op: op.op,
            patch: op.patch === null ? Prisma.DbNull : (op.patch as Prisma.InputJsonValue),
            fields: op.fields,
          },
        })
      } catch (err) {
        // `(deviceId, seq)` is unique, so a redelivered op lands here. That is
        // the intended outcome and not a failure: the iCloud transport has no
        // delivery receipt, so every batch is read at least twice.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
        throw err
      }
    },
  })

  return initSyncLog()
}

/** The raw client, for the sync routes' own queries over the log. */
export const dbRaw = base

/** BigInt (UptimeRobot ids) is not JSON-serializable — patch it globally. */
Object.defineProperty(BigInt.prototype, 'toJSON', {
  value: function (this: bigint) {
    return this.toString()
  },
  configurable: true,
  writable: true,
})
