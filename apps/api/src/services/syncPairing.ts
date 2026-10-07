import { randomBytes, randomInt } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { hashPassword, verifyPassword } from '../auth.js'
import { dbRaw } from '../db.js'
import { env } from '../env.js'

/**
 * Pairing a device, over the local network, once.
 *
 * There is no account server to authenticate against, so trust has to be
 * established out of band. The Mac shows a short code (the web UI renders it
 * as a QR), the phone claims it, and from then on the phone holds a long
 * random token. The code is the weak part by design, so it is kept weak for
 * as little time as possible: single use, ten minutes, and the claim is the
 * only unauthenticated route in the API.
 */

const PAIRING_KEY = 'sync.pairing'
const CODE_TTL_MS = 10 * 60 * 1000

/**
 * No `I`, `O`, `0` or `1`. The code gets read off one screen and typed into
 * another, and those four are where that goes wrong.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

type StoredPairing = {
  code: string
  expiresAt: string
}

function newCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}

/** The addresses the phone can actually reach this machine on. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      out.push(entry.address)
    }
  }
  return out
}

export type PairingOffer = {
  code: string
  expiresAt: string
  port: number
  addresses: string[]
}

/**
 * Open a pairing window. Replaces any code that is still open — two valid
 * codes at once is two chances to guess, for no benefit.
 */
export async function startPairing(): Promise<PairingOffer> {
  const code = newCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()
  const stored: StoredPairing = { code, expiresAt }

  await dbRaw.appSetting.upsert({
    where: { key: PAIRING_KEY },
    create: { key: PAIRING_KEY, value: stored },
    update: { value: stored },
  })

  return { code, expiresAt, port: env.PORT, addresses: lanAddresses() }
}

export async function cancelPairing(): Promise<void> {
  await dbRaw.appSetting.deleteMany({ where: { key: PAIRING_KEY } })
}

export type ClaimResult =
  { ok: true; deviceId: string; token: string; name: string } | { ok: false; reason: string }

/**
 * Redeem a code for a device token.
 *
 * The code is consumed before the device row is written, so a code cannot be
 * claimed twice even if two phones race for it.
 */
export async function claimPairing(input: {
  code: string
  name: string
  platform: string
}): Promise<ClaimResult> {
  const row = await dbRaw.appSetting.findUnique({ where: { key: PAIRING_KEY } })
  const stored = row?.value as StoredPairing | undefined
  if (!stored?.code) return { ok: false, reason: 'keine Kopplung offen' }

  if (Date.parse(stored.expiresAt) < Date.now()) {
    await cancelPairing()
    return { ok: false, reason: 'Code abgelaufen' }
  }

  if (input.code.trim().toUpperCase() !== stored.code) {
    return { ok: false, reason: 'Code stimmt nicht' }
  }

  // Burn it first. A second claim then finds nothing open, whichever request
  // got here first.
  const consumed = await dbRaw.appSetting.deleteMany({ where: { key: PAIRING_KEY } })
  if (consumed.count === 0) return { ok: false, reason: 'Code bereits benutzt' }

  const token = randomBytes(32).toString('base64url')
  const device = await dbRaw.syncDevice.create({
    data: {
      name: input.name.slice(0, 80) || 'Gerät',
      platform: input.platform === 'ios' ? 'ios' : 'macos',
      tokenHash: await hashPassword(token),
    },
  })

  return { ok: true, deviceId: device.id, token, name: device.name }
}

export type AuthedDevice = {
  id: string
  name: string
  platform: string
  cursor: string
}

/**
 * Check a device's bearer token.
 *
 * Deliberately not folded into `registerAuth`: a device token must not be
 * interchangeable with the owner's JWT or with `SERVICE_TOKEN`. It opens the
 * sync routes and nothing else, so a phone that goes missing cannot be used
 * to read the mail inbox.
 */
export async function authenticateDevice(
  deviceId: string | undefined,
  token: string | undefined,
): Promise<AuthedDevice | null> {
  if (!deviceId || !token) return null

  const device = await dbRaw.syncDevice.findUnique({ where: { id: deviceId } })
  if (!device || !device.tokenHash || device.revokedAt) return null
  if (!(await verifyPassword(token, device.tokenHash))) return null

  return { id: device.id, name: device.name, platform: device.platform, cursor: device.cursor }
}

/**
 * A device by id, without checking a token.
 *
 * For the iCloud transport: there the relaying process is the desktop app on
 * this machine, which holds `SERVICE_TOKEN` and is pushing on the phone's
 * behalf. The phone's own token never leaves the phone, so the device is
 * identified but not authenticated — which is why the route that uses this
 * needs the service credential and is reachable only from localhost.
 */
export async function knownDevice(deviceId: string): Promise<AuthedDevice | null> {
  const device = await dbRaw.syncDevice.findUnique({ where: { id: deviceId } })
  if (!device || device.revokedAt) return null
  return { id: device.id, name: device.name, platform: device.platform, cursor: device.cursor }
}

/** Every device the Mac relays for over iCloud. */
export async function relayableDevices(): Promise<AuthedDevice[]> {
  const devices = await dbRaw.syncDevice.findMany({
    where: { platform: 'ios', revokedAt: null },
    orderBy: { pairedAt: 'asc' },
  })
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    platform: d.platform,
    cursor: d.cursor,
  }))
}

export async function noteDeviceSeen(deviceId: string, cursor?: string): Promise<void> {
  await dbRaw.syncDevice.update({
    where: { id: deviceId },
    data: { lastSeenAt: new Date(), ...(cursor === undefined ? {} : { cursor }) },
  })
}
