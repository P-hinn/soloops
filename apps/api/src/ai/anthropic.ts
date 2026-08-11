import Anthropic from '@anthropic-ai/sdk'
import { env } from '../env.js'

let client: Anthropic | null = null

export function anthropic(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY ist nicht gesetzt — AI-Funktionen sind deaktiviert.')
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  return client
}

export const MODEL = env.ANTHROPIC_MODEL
