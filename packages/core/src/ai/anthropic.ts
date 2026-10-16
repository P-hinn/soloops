import Anthropic from '@anthropic-ai/sdk'
import { serviceKeys } from '../settings.js'

let client: Anthropic | null = null
let clientKey: string | null = null

/**
 * The Anthropic client, with the key that is in force now.
 *
 * Async because the key may come from the database — it can be entered in the
 * interface, and a key entered there has to work without a restart. The
 * client is cached, but keyed on the key itself: changing it builds a new one
 * instead of silently keeping the old.
 */
export async function anthropic(): Promise<Anthropic> {
  const { anthropic: key } = await serviceKeys()
  if (!key) {
    throw new Error('Kein Anthropic-Schlüssel — AI-Funktionen sind deaktiviert.')
  }
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key })
    clientKey = key
  }
  return client
}

/** The model to ask. From the settings, so it can be changed in the app. */
export async function model(): Promise<string> {
  return (await serviceKeys()).anthropicModel ?? 'claude-sonnet-4-5'
}
