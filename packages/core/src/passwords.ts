/**
 * Hashing a secret, and checking one.
 *
 * Here and not next to the Fastify hook that uses it, because two very
 * different secrets go through it: the owner's password, and the long-lived
 * token a paired phone holds (services/syncPairing.ts). Both are stored as a
 * hash and only ever compared, so the rule for how that is done belongs in
 * one place.
 *
 * scrypt with a per-secret salt, and the comparison is time-constant — a
 * token check that leaks its answer through its duration is a token check
 * that can be brute-forced.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(_scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, 64)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
