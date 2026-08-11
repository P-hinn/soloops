import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { env } from '../env.js'

/**
 * Verschlüsselung für Fremd-Zugangsdaten, die die API selbst benutzen muss
 * (Google-Refresh-Tokens, CalDAV-App-Passwörter).
 *
 * Bewusst etwas anderes als der Passwort-Manager: dort kennt der Server den
 * Schlüssel nie. Hier *muss* er entschlüsseln können, um zu synchronisieren.
 * Der Schutz gilt also dem Datenbank-Dump, nicht dem laufenden Server —
 * der Schlüssel wird aus JWT_SECRET abgeleitet und liegt nur in der .env.
 */
const key = createHash('sha256').update(`soloops:secretbox:${env.JWT_SECRET}`).digest()

export function seal(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(
    '.',
  )
}

export function open(sealed: string): string {
  const [ivB64, tagB64, bodyB64] = sealed.split('.')
  if (!ivB64 || !tagB64 || !bodyB64) throw new Error('Ungültiges Geheimnis-Format')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(bodyB64, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}

export function openOrNull(sealed: string | null): string | null {
  if (!sealed) return null
  try {
    return open(sealed)
  } catch {
    return null
  }
}
