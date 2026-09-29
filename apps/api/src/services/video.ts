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
 * Creates a video room without a third-party account.
 *
 * JITSI  — a room name is enough, nobody has to sign in. The name carries 8
 *          random characters on purpose: with Jitsi the room name is the only
 *          secret, and a guessable name would be an open meeting.
 * CUSTOM — your own permanent room (Zoom/Teams/Meet) from VIDEO_CUSTOM_URL.
 * GOOGLE_MEET — not created here but by Google when the calendar entry is
 *          created (see services/google.ts). Falls back to Jitsi without a
 *          connected Google account.
 */
export function createVideoRoom(
  title: string,
  provider: VideoProviderName = env.VIDEO_PROVIDER,
): { videoUrl: string; videoProvider: VideoProviderName } | null {
  if (provider === 'CUSTOM') {
    if (!env.VIDEO_CUSTOM_URL) return null
    return { videoUrl: env.VIDEO_CUSTOM_URL, videoProvider: 'CUSTOM' }
  }

  // GOOGLE_MEET without a Google account and JITSI both end up here.
  const base = env.JITSI_BASE_URL.replace(/\/$/, '')
  const room = `soloops-${slug(title)}-${randomBytes(4).toString('hex')}`
  return { videoUrl: `${base}/${room}`, videoProvider: 'JITSI' }
}
