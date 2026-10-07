import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { dbRaw, prisma } from '../db.js'
import { encodeRow } from '../services/syncCodec.js'
import { SYNC_ENTITY_NAMES, byRankAsc, specOf, type SyncEntity } from '../services/syncEntities.js'
import { applyOps } from '../services/syncApply.js'
import type { IncomingOp } from '../services/syncMerge.js'
import {
  authenticateDevice,
  cancelPairing,
  claimPairing,
  knownDevice,
  lanAddresses,
  noteDeviceSeen,
  relayableDevices,
  startPairing,
  type AuthedDevice,
} from '../services/syncPairing.js'
import { hostDevice } from '../services/syncLog.js'
import { env } from '../env.js'

/**
 * The sync endpoints.
 *
 * Four of them, and the shape is the whole design: a device pulls everybody
 * else's ops since its cursor, pushes its own, and a device that has never
 * synced starts from a snapshot instead of replaying the log from the first
 * day. There is no session and no long-lived connection, because the two
 * transports this has to work over are a LAN request and a file dropped in an
 * iCloud folder.
 */

/** One pull stays well inside a phone's background execution window. */
const MAX_PULL = 500
/** A push larger than this is a client bug, not a long weekend offline. */
const MAX_PUSH = 1000

const opSchema = z.object({
  deviceId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  hlc: z.string().min(1),
  entity: z.string().min(1),
  entityId: z.string().min(1),
  op: z.enum(['upsert', 'delete']),
  patch: z.unknown().optional(),
})

const routes: FastifyPluginAsync = async (app) => {
  // --- Pairing, from the web UI -------------------------------------------
  // These two are the owner's, so they use the normal authentication.

  app.post('/pair/start', { onRequest: app.authenticate }, async () => {
    const offer = await startPairing()
    return offer
  })

  app.post('/pair/cancel', { onRequest: app.authenticate }, async (_req, reply) => {
    await cancelPairing()
    return reply.code(204).send()
  })

  app.get('/devices', { onRequest: app.authenticate }, async () => {
    const devices = await dbRaw.syncDevice.findMany({
      orderBy: [{ platform: 'asc' }, { pairedAt: 'asc' }],
      select: {
        id: true,
        name: true,
        platform: true,
        pairedAt: true,
        lastSeenAt: true,
        revokedAt: true,
        cursor: true,
      },
    })
    const pending = await dbRaw.syncOp.count()
    return { host: hostDevice(), port: env.PORT, addresses: lanAddresses(), devices, ops: pending }
  })

  app.post('/devices/:id/revoke', { onRequest: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    // Revoked, not deleted: the op log keeps pointing at this id, and a
    // revoked device has to stay distinguishable from one that never was.
    return dbRaw.syncDevice.update({
      where: { id },
      data: { revokedAt: new Date(), tokenHash: null },
      select: { id: true, name: true, revokedAt: true },
    })
  })

  // --- Claiming a code, from the phone ------------------------------------
  // The one route here without authentication. It is what pairing *is*: the
  // device has no credential yet. The code is single-use and short-lived —
  // see services/syncPairing.ts.

  app.post('/pair/claim', async (req, reply) => {
    const body = z
      .object({
        code: z.string().min(1).max(32),
        name: z.string().min(1).max(80),
        platform: z.enum(['ios', 'macos']),
      })
      .parse(req.body)

    const result = await claimPairing(body)
    if (!result.ok) return reply.code(401).send({ error: result.reason })

    return reply.code(201).send({
      deviceId: result.deviceId,
      token: result.token,
      name: result.name,
      host: hostDevice(),
    })
  })

  // --- Device-authenticated routes ----------------------------------------

  /**
   * A device token opens these and nothing else. Kept local to this plugin
   * rather than added to `registerAuth`, so a phone token can never stand in
   * for the owner's JWT elsewhere in the API.
   */
  const requireDevice = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const deviceId = req.headers['x-soloops-device']
    const device = await authenticateDevice(
      typeof deviceId === 'string' ? deviceId : undefined,
      token,
    )
    if (!device) {
      await reply.code(401).send({ error: 'Gerät nicht gekoppelt' })
      return
    }
    ;(req as FastifyRequest & { device?: AuthedDevice }).device = device
  }

  const deviceOf = (req: FastifyRequest): AuthedDevice =>
    (req as FastifyRequest & { device?: AuthedDevice }).device!

  /**
   * Everything that happened elsewhere since the cursor.
   *
   * The device's own ops are excluded: it already has them, and sending them
   * back is how a two-device sync turns into an infinite loop.
   */
  const doPull = async (deviceId: string, cursor: string, limit: number) => {
    const ops = await dbRaw.syncOp.findMany({
      where: { hlc: { gt: cursor }, deviceId: { not: deviceId } },
      orderBy: { hlc: 'asc' },
      take: limit,
      select: {
        deviceId: true,
        seq: true,
        hlc: true,
        entity: true,
        entityId: true,
        op: true,
        patch: true,
      },
    })

    // Only advance the stored cursor once the device confirms it on the next
    // call. Writing it here would lose the batch if the phone dies mid-flight.
    await noteDeviceSeen(deviceId)

    return {
      ops,
      cursor: ops.length > 0 ? ops[ops.length - 1]!.hlc : cursor,
      more: ops.length === limit,
    }
  }

  app.post('/pull', { onRequest: requireDevice }, async (req) => {
    const device = deviceOf(req)
    const body = z
      .object({
        cursor: z.string().default(''),
        limit: z.number().int().min(1).max(MAX_PULL).default(MAX_PULL),
      })
      .parse(req.body ?? {})

    return doPull(device.id, body.cursor, body.limit)
  })

  /**
   * Changes made on the device.
   *
   * The response reports every op individually. A client that only learns
   * "accepted" cannot tell a merge it lost from a row it should stop
   * retrying, and would either keep pushing forever or silently drop work.
   */
  const doPush = async (
    deviceId: string,
    ops: z.infer<typeof opSchema>[],
    cursor: string | undefined,
  ) => {
    // An op may only claim the identity it was pushed under. Without this a
    // paired phone could forge ops from the Mac and win every conflict by
    // writing a stamp into the future.
    const foreign = ops.filter((op) => op.deviceId !== deviceId)
    if (foreign.length > 0) {
      const err = new Error('Ops muessen die eigene deviceId tragen') as Error & {
        statusCode?: number
      }
      err.statusCode = 403
      throw err
    }

    const results = await applyOps(ops as IncomingOp[])
    await noteDeviceSeen(deviceId, cursor)

    return {
      applied: results.filter((r) => r.status === 'applied').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      failed: results.filter((r) => r.status === 'failed').length,
      results,
    }
  }

  app.post('/push', { onRequest: requireDevice }, async (req) => {
    const device = deviceOf(req)
    const body = z
      .object({
        ops: z.array(opSchema).max(MAX_PUSH),
        /** What the device has consumed. Stored once it says so. */
        cursor: z.string().optional(),
      })
      .parse(req.body)

    return doPush(device.id, body.ops, body.cursor)
  })

  // --- The iCloud relay ---------------------------------------------------
  //
  // When the Mac is asleep or on another network, the phone cannot reach it.
  // It then writes its ops as files into a shared iCloud container, and the
  // desktop app's watcher hands them in here — see
  // apps/desktop/src-tauri/src/sync.rs.
  //
  // These two carry the owner's credential, not the phone's, because the
  // caller is the app on this machine. The device is therefore identified and
  // not authenticated; the trust comes from holding `SERVICE_TOKEN`, which
  // already opens the whole API.

  app.post('/relay/devices', { onRequest: app.authenticate }, async () => {
    return { devices: await relayableDevices() }
  })

  app.post('/relay/pull', { onRequest: app.authenticate }, async (req, reply) => {
    const body = z
      .object({
        deviceId: z.string().min(1),
        cursor: z.string().default(''),
        limit: z.number().int().min(1).max(MAX_PULL).default(MAX_PULL),
      })
      .parse(req.body)

    const device = await knownDevice(body.deviceId)
    if (!device) return reply.code(404).send({ error: 'Gerät unbekannt oder widerrufen' })

    return doPull(device.id, body.cursor, body.limit)
  })

  app.post('/relay/push', { onRequest: app.authenticate }, async (req, reply) => {
    const body = z
      .object({
        deviceId: z.string().min(1),
        ops: z.array(opSchema).max(MAX_PUSH),
        cursor: z.string().optional(),
      })
      .parse(req.body)

    const device = await knownDevice(body.deviceId)
    if (!device) return reply.code(404).send({ error: 'Gerät unbekannt oder widerrufen' })

    return doPush(device.id, body.ops, body.cursor)
  })

  /**
   * Everything, for a device that has never synced.
   *
   * Replaying the log from the beginning would also work and would be slower
   * every month. The cursor that comes back is the log's current head, so the
   * device's first pull picks up exactly where the snapshot stops.
   */
  app.post('/snapshot', { onRequest: requireDevice }, async (req) => {
    const device = deviceOf(req)

    // Read the head *before* the rows. The other way round, an op landing
    // between the two reads would be both in the snapshot and after the
    // cursor — harmless for an upsert, but a delete would be replayed onto a
    // row the snapshot no longer contains.
    const head = await dbRaw.syncOp.findFirst({ orderBy: { hlc: 'desc' }, select: { hlc: true } })

    const entities: Record<string, unknown[]> = {}
    for (const entity of [...SYNC_ENTITY_NAMES].sort(byRankAsc)) {
      const rows = (await (
        prisma as unknown as Record<string, { findMany: (args: unknown) => Promise<unknown> }>
      )[specOf(entity).model]!.findMany({})) as Record<string, unknown>[]

      entities[entity] = rows.map((row) => ({
        id: row.id as string,
        ...encodeRow(entity as SyncEntity, row),
      }))
    }

    await noteDeviceSeen(device.id)

    return { cursor: head?.hlc ?? '', entities }
  })
}

export default routes
