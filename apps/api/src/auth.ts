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
    /** Gesetzt für jede authentifizierte Anfrage. `service` = Worker/MCP. */
    principal?: { type: 'user'; userId: string } | { type: 'service' }
  }
}

/**
 * Zwei Wege hinein: JWT-Cookie/Bearer für die UI, statischer SERVICE_TOKEN
 * für Worker und MCP-Server.
 */
/**
 * Erster Zugriff des MCP-Servers wird vermerkt, damit das Onboarding den
 * Schritt selbst als erledigt erkennt. Höchstens einmal pro Stunde geschrieben —
 * ein DB-Write pro Anfrage wäre Verschwendung.
 */
let mcpSeenWrittenAt = 0

async function noteServiceAccess(): Promise<void> {
  const now = Date.now()
  if (now - mcpSeenWrittenAt < 3_600_000) return
  mcpSeenWrittenAt = now
  const { prisma } = await import('./db.js')
  await prisma.appSetting
    .upsert({
      where: { key: 'mcp.lastSeenAt' },
      create: { key: 'mcp.lastSeenAt', value: new Date().toISOString() },
      update: { value: new Date().toISOString() },
    })
    .catch(() => {})
}

export function registerAuth(app: FastifyInstance): void {
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization
    if (header?.startsWith('Bearer ')) {
      const token = header.slice(7)
      if (token === env.SERVICE_TOKEN) {
        req.principal = { type: 'service' }
        void noteServiceAccess()
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
