import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '../db.js'

/**
 * Tokens for the other direction: n8n calling into soloops.
 *
 * A workflow could use SERVICE_TOKEN — it is in the .env and it works. It
 * should not: that one token also opens the MCP server and the desktop app,
 * it cannot be revoked without taking both down with it, and it ends up
 * copied into an n8n credential store that soloops does not control. Hence a
 * token per connection, revocable on its own, scoped, and stored only as a
 * hash.
 */

const PREFIX = 'slp_'

/** Enough entropy that the hash is the only thing worth attacking. */
export function mintToken(): string {
  return PREFIX + randomBytes(24).toString('base64url')
}

/**
 * SHA-256 and not scrypt, deliberately.
 *
 * A password is short and guessable and needs the cost. This is 192 random
 * bits — there is nothing to brute-force — and it is verified on every call a
 * workflow makes, where a deliberately slow hash would be a self-inflicted
 * rate limit.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The leading characters, so a token can be named in a list without being held. */
export function prefixOf(token: string): string {
  return token.slice(0, PREFIX.length + 6)
}

export type TokenScope = 'read' | 'write'

export async function createToken(
  name: string,
  scopes: TokenScope[],
): Promise<{ token: string; id: string; prefix: string }> {
  const token = mintToken()
  const row = await prisma.automationToken.create({
    data: {
      name,
      tokenHash: hashToken(token),
      prefix: prefixOf(token),
      // An empty list would read as read-only further down; make that explicit.
      scopes: scopes.length ? scopes : ['read'],
    },
  })
  // The only time the token itself exists outside the caller's hands.
  return { token, id: row.id, prefix: row.prefix }
}

export type AutomationPrincipal = {
  tokenId: string
  scopes: TokenScope[]
}

/**
 * Resolve a bearer token, or null.
 *
 * The lookup is by hash, which is indexed and unique, so this is one query
 * and no comparison loop. The constant-time compare is kept anyway for the
 * one byte it costs — a hash lookup that matched is already proof, but the
 * check documents the intent and survives a future change to a non-unique
 * index.
 */
export async function resolveToken(token: string): Promise<AutomationPrincipal | null> {
  if (!token.startsWith(PREFIX)) return null
  const hash = hashToken(token)
  const row = await prisma.automationToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, scopes: true, revokedAt: true, tokenHash: true },
  })
  if (!row || row.revokedAt) return null

  const a = Buffer.from(row.tokenHash, 'utf8')
  const b = Buffer.from(hash, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  void noteUse(row.id)
  return { tokenId: row.id, scopes: row.scopes as TokenScope[] }
}

/**
 * When a token was last used. Written at most once a minute per token — a
 * database write on every call from a busy workflow would be a waste, and
 * minute-level resolution is all "is this connection alive" needs.
 */
const lastWrite = new Map<string, number>()

async function noteUse(tokenId: string): Promise<void> {
  const now = Date.now()
  if (now - (lastWrite.get(tokenId) ?? 0) < 60_000) return
  lastWrite.set(tokenId, now)
  await prisma.automationToken
    .update({ where: { id: tokenId }, data: { lastUsedAt: new Date() } })
    .catch(() => {})
}

export function canWrite(principal: AutomationPrincipal): boolean {
  return principal.scopes.includes('write')
}
