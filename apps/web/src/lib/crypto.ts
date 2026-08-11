/**
 * Client-seitige Verschlüsselung für den Passwort-Manager.
 *
 * Ableitung: PBKDF2-SHA-512 mit 600.000 Iterationen (OWASP-Empfehlung) aus dem
 * Master-Passwort + einem serverseitig gespeicherten Salt.
 * Verschlüsselung: AES-256-GCM mit einer frischen 12-Byte-IV pro Eintrag.
 *
 * Der Server bekommt ausschließlich Salt, einen Verifier-Blob und Ciphertext
 * zu sehen — weder Master-Passwort noch Key verlassen den Browser.
 */

const ITERATIONS = 600_000
const CHECK_PLAINTEXT = 'soloops-vault-v1'

export type Secret = {
  password?: string
  totpSecret?: string
  notes?: string
  customFields?: { label: string; value: string }[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function randomSalt(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)))
}

export async function deriveKey(masterPassword: string, saltB64: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(masterPassword), 'PBKDF2', false, [
    'deriveKey',
  ])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(saltB64) as BufferSource, iterations: ITERATIONS, hash: 'SHA-512' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

export async function encryptJson(key: CryptoKey, value: unknown): Promise<{ cipherText: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(JSON.stringify(value)),
  )
  return { cipherText: toB64(cipher), iv: toB64(iv) }
}

export async function decryptJson<T>(key: CryptoKey, cipherText: string, iv: string): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(iv) as BufferSource },
    key,
    fromB64(cipherText) as BufferSource,
  )
  return JSON.parse(dec.decode(plain)) as T
}

/** Verifier: erlaubt es zu prüfen, ob das eingegebene Master-Passwort stimmt. */
export async function buildVaultCheck(key: CryptoKey): Promise<string> {
  const { cipherText, iv } = await encryptJson(key, CHECK_PLAINTEXT)
  return `${iv}.${cipherText}`
}

export async function verifyVaultCheck(key: CryptoKey, check: string): Promise<boolean> {
  const [iv, cipherText] = check.split('.')
  if (!iv || !cipherText) return false
  try {
    return (await decryptJson<string>(key, cipherText, iv)) === CHECK_PLAINTEXT
  } catch {
    return false
  }
}

/** Passwortgenerator — Standard: 24 Zeichen aus einem eindeutigen Alphabet. */
export function generatePassword(length = 24, symbols = true): string {
  const alphabet =
    'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' + (symbols ? '!@#$%^&*()-_=+[]{}' : '')
  const bytes = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}
