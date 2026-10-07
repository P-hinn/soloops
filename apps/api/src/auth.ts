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
    /**
     * Set on every authenticated request. `service` = MCP server or app,
     * `automation` = an n8n workflow through one of its own tokens.
     */
    principal?:
      | { type: 'user'; userId: string }
      | { type: 'service' }
      | { type: 'automation'; tokenId: string; scopes: ('read' | 'write')[] }
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
 * Resolve whoever is calling, or answer 401.
 *
 * Three kinds: a JWT for the UI, the static SERVICE_TOKEN for the worker and
 * the MCP server, and a per-connection automation token for workflows running
 * in n8n. The automation tokens are kept apart from SERVICE_TOKEN on purpose —
 * that one also opens the desktop app and the MCP server and cannot be
 * revoked without taking both down.
 */
async function resolvePrincipal(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7)
    if (token === env.SERVICE_TOKEN) {
      req.principal = { type: 'service' }
      const client = req.headers['x-soloops-client']
      void noteServiceAccess(typeof client === 'string' ? client : 'other')
      return
    }
    // Only tokens carrying the automation prefix reach the database — a JWT
    // should not cost a lookup on its way past.
    if (token.startsWith('slp_')) {
      const { resolveToken } = await import('./services/automationTokens.js')
      const principal = await resolveToken(token)
      if (principal) {
        req.principal = { type: 'automation', ...principal }
        return
      }
      // A revoked or made-up automation token is not a JWT either. Saying so
      // beats the confusing "jwt malformed" from the branch below.
      return reply.code(401).send({ error: 'Automations-Token ungültig oder widerrufen' })
    }
  }
  try {
    const payload = await req.jwtVerify<{ sub: string }>()
    req.principal = { type: 'user', userId: payload.sub }
  } catch {
    return reply.code(401).send({ error: 'Nicht authentifiziert' })
  }
}

export function registerAuth(app: FastifyInstance): void {
  /**
   * The ordinary gate. An automation token does *not* pass it.
   *
   * This is the whole reason the connector has a surface of its own. A token
   * handed to a workflow should reach the handful of operations that workflow
   * needs — not the mailbox, not the invoices, not every route that happens to
   * exist. Widening that is then a deliberate edit to one route file rather
   * than a side effect of minting a token.
   */
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    await resolvePrincipal(req, reply)
    if (reply.sent) return
    if (req.principal?.type === 'automation') {
      return reply
        .code(403)
        .send({ error: 'Automations-Token gilt nur für /api/automations/connector' })
    }
  })

  /**
   * The connector gate: automation tokens plus the two principals that are
   * already trusted with everything, so the interface can try a connection
   * out without minting a token first.
   *
   * Anything that is not a GET needs the write scope. Deriving it from the
   * method rather than listing routes means a new connector endpoint cannot
   * be added without a scope by accident.
   */
  app.decorate('authenticateConnector', async (req: FastifyRequest, reply: FastifyReply) => {
    await resolvePrincipal(req, reply)
    if (reply.sent) return
    const principal = req.principal
    if (principal?.type !== 'automation') return
    if (req.method !== 'GET' && !principal.scopes.includes('write')) {
      return reply.code(403).send({ error: 'Token hat keine Schreibrechte' })
    }
  })
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    authenticateConnector: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}
