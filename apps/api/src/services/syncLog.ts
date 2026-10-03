import { AsyncLocalStorage } from 'node:async_hooks'
import { HlcClock, type Hlc } from './hlc.js'
import type { Patch } from './syncCodec.js'
import type { OpKind } from './syncMerge.js'
import type { SyncEntity } from './syncEntities.js'

/**
 * The op log: this machine's identity, its clock, and the one function that
 * appends to it.
 *
 * Kept apart from the Prisma hook that calls it so that the hook stays about
 * intercepting writes and this stays about recording them.
 */

export type RecordedOp = {
  deviceId: string
  seq: number
  hlc: Hlc
  entity: SyncEntity
  entityId: string
  op: OpKind
  patch: Patch | null
  fields: string[]
}

/**
 * While an op from another device is being applied, writes must not be logged
 * as if they happened here.
 *
 * Without this the two devices ping-pong: the Mac applies the phone's edit,
 * logs it under its own id, sends it back, the phone applies it, logs it,
 * sends it on. The CalDAV sync in this codebase solves the same problem with
 * `lastPushedAt`; between devices the answer is to carry the origin instead,
 * so an op keeps one identity however far it travels.
 */
type ApplyContext = { readonly origin: RecordedOp }

const applyStore = new AsyncLocalStorage<ApplyContext>()

/** True while inside `asRemote` — the Prisma hook checks this and stands down. */
export function isApplyingRemote(): boolean {
  return applyStore.getStore() !== undefined
}

export function currentOrigin(): RecordedOp | null {
  return applyStore.getStore()?.origin ?? null
}

/** Run a write that belongs to another device's op. */
export function asRemote<T>(origin: RecordedOp, fn: () => Promise<T>): Promise<T> {
  return applyStore.run({ origin }, fn)
}

/**
 * The host's device id, and its clock.
 *
 * Both are read once at startup. The clock is restored from the newest op in
 * the log rather than from the wall clock: a Mac that was asleep while the
 * phone kept working would otherwise mint stamps that sort before ops it has
 * already handed out, and the phone would reject the host's next edit as
 * stale. See hlc.ts.
 */
let hostDeviceId: string | null = null
let clock: HlcClock | null = null

export type SyncLogDeps = {
  /**
   * Which AppSetting row holds this process's device id. The API and the
   * worker both write on this machine but mint sequence numbers separately,
   * so they must not share an identity — see db.ts.
   */
  deviceIdKey: string
  getSetting: (key: string) => Promise<string | null>
  setSetting: (key: string, value: string) => Promise<void>
  newestHlc: () => Promise<Hlc | null>
  nextSeq: (deviceId: string) => Promise<number>
  insert: (op: RecordedOp) => Promise<void>
  registerHost: (deviceId: string) => Promise<void>
  newId: () => string
}

let deps: SyncLogDeps | null = null

export function configureSyncLog(next: SyncLogDeps): void {
  deps = next
}

function requireDeps(): SyncLogDeps {
  if (!deps) throw new Error('Sync-Log nicht initialisiert — configureSyncLog fehlt')
  return deps
}

export async function initSyncLog(): Promise<{ deviceId: string }> {
  const d = requireDeps()

  const stored = await d.getSetting(d.deviceIdKey)
  const deviceId = stored ?? d.newId()
  if (!stored) await d.setSetting(d.deviceIdKey, deviceId)

  // The host is a device like any other, so that every op in the log has an
  // origin — including the ones made in the web UI on this machine.
  await d.registerHost(deviceId)

  const newest = await d.newestHlc()
  hostDeviceId = deviceId
  clock = HlcClock.fromHlc(deviceId, newest ?? '')

  return { deviceId }
}

export function hostDevice(): string {
  if (!hostDeviceId) throw new Error('Sync-Log nicht initialisiert')
  return hostDeviceId
}

export function hostClock(): HlcClock {
  if (!clock) throw new Error('Sync-Log nicht initialisiert')
  return clock
}

/** Whether the log is live. Writes before `initSyncLog` simply are not logged. */
export function isReady(): boolean {
  return clock !== null && hostDeviceId !== null
}

export type LocalChange = {
  entity: SyncEntity
  entityId: string
  op: OpKind
  /** Null for a delete. */
  patch: Patch | null
  /** The fields the write touched. Empty for a delete. */
  fields: string[]
}

/**
 * Append changes made on this machine.
 *
 * One stamp per change, not per batch: two edits inside one request are two
 * distinct points in time, and collapsing them would make a later field-level
 * decision impossible to reconstruct.
 */
export async function recordLocal(changes: readonly LocalChange[]): Promise<RecordedOp[]> {
  if (changes.length === 0 || !isReady()) return []
  const d = requireDeps()
  const deviceId = hostDevice()
  const c = hostClock()

  let seq = await d.nextSeq(deviceId)
  const recorded: RecordedOp[] = []

  for (const change of changes) {
    const op: RecordedOp = {
      deviceId,
      seq: seq++,
      hlc: c.next(),
      entity: change.entity,
      entityId: change.entityId,
      op: change.op,
      patch: change.patch,
      fields: change.fields,
    }
    await d.insert(op)
    recorded.push(op)
  }

  return recorded
}

/**
 * Append an op that came from another device, under its own identity.
 *
 * The `(deviceId, seq)` pair is unique, so re-delivering an op is a no-op.
 * That matters more than it sounds: the iCloud transport has no delivery
 * receipt, so a batch the phone wrote before going offline will be read again.
 */
export async function recordRemote(op: RecordedOp): Promise<void> {
  const d = requireDeps()
  hostClock().witness(op.hlc)
  await d.insert(op)
}
