import { randomBytes } from 'node:crypto'
import { env } from '../env.js'

export type VideoProviderName = 'JITSI' | 'GOOGLE_MEET' | 'CUSTOM'

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'meeting'
  )
}

/**
 * Erzeugt einen Videoraum ohne fremdes Konto.
 *
 * JITSI  — ein Raumname reicht, niemand muss sich anmelden. Der Name enthält
 *          bewusst 8 Zufallszeichen: bei Jitsi ist der Raumname das einzige
 *          Geheimnis, ein erratbarer Name wäre ein offenes Meeting.
 * CUSTOM — der eigene Dauerraum (Zoom/Teams/Meet) aus VIDEO_CUSTOM_URL.
 * GOOGLE_MEET — wird nicht hier erzeugt, sondern von Google beim Anlegen des
 *          Kalendereintrags (siehe services/google.ts). Fällt ohne verbundenes
 *          Google-Konto auf Jitsi zurück.
 */
export function createVideoRoom(
  title: string,
  provider: VideoProviderName = env.VIDEO_PROVIDER,
): { videoUrl: string; videoProvider: VideoProviderName } | null {
  if (provider === 'CUSTOM') {
    if (!env.VIDEO_CUSTOM_URL) return null
    return { videoUrl: env.VIDEO_CUSTOM_URL, videoProvider: 'CUSTOM' }
  }

  // GOOGLE_MEET ohne Google-Konto und JITSI landen beide hier.
  const base = env.JITSI_BASE_URL.replace(/\/$/, '')
  const room = `soloops-${slug(title)}-${randomBytes(4).toString('hex')}`
  return { videoUrl: `${base}/${room}`, videoProvider: 'JITSI' }
}
