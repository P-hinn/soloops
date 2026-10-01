import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { env } from './env.js'

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

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on every authenticated request. `service` = MCP server or app. */
    principal?: { type: 'user'; userId: string } | { type: 'service' }
  }
}

/**
 * When a service client was last here. The settings page shows it for the MCP
 * server — proof that the connector really works and not merely exists.
 *
 * The desktop app uses the same token, so it is kept apart by the client
 * header; without one it stays an anonymous service. Written at most once a
 * minute per client — a database write per request would be a waste.
 */
const seenWrittenAt = new Map<string, number>()

/** Known clients only — a header may not invent new settings keys. */
const SEEN_KEYS: Record<string, string> = {
  mcp: 'mcp.lastSeenAt',
  desktop: 'desktop.lastSeenAt',
}

async function noteServiceAccess(client: string): Promise<void> {
  const key = SEEN_KEYS[client] ?? 'service.lastSeenAt'
  const now = Date.now()
  if (now - (seenWrittenAt.get(key) ?? 0) < 60_000) return
  seenWrittenAt.set(key, now)
  const { prisma } = await import('./db.js')
  const value = new Date().toISOString()
  await prisma.appSetting
    .upsert({ where: { key }, create: { key, value }, update: { value } })
    .catch(() => {})
}

/**
 * Two ways in: a JWT cookie/bearer for the UI, a static SERVICE_TOKEN for the
 * worker and the MCP server.
 */
export function registerAuth(app: FastifyInstance): void {
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7)
      if (token === env.SERVICE_TOKEN) {
        req.principal = { type: 'service' }
        const client = req.headers['x-soloops-client']
        void noteServiceAccess(typeof client === 'string' ? client : 'other')
        return
      }
    }
    try {
      const payload = await req.jwtVerify<{ sub: string }>()
      req.principal = { type: 'user', userId: payload.sub }
    } catch {
      return reply.code(401).send({ error: 'Nicht authentifiziert' })
    }
  })
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}
