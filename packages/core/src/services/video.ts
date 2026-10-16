import { randomBytes } from 'node:crypto'

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
/** Where the rooms come from. Passed in, so this stays a pure function. */
export type VideoConfig = {
  provider: VideoProviderName
  jitsiBaseUrl: string
  customUrl: string
}

export function createVideoRoom(
  title: string,
  config: VideoConfig,
): { videoUrl: string; videoProvider: VideoProviderName } | null {
  if (config.provider === 'CUSTOM') {
    if (!config.customUrl) return null
    return { videoUrl: config.customUrl, videoProvider: 'CUSTOM' }
  }

  // GOOGLE_MEET without a Google account and JITSI both end up here.
  const base = config.jitsiBaseUrl.replace(/\/$/, '')
  const room = `soloops-${slug(title)}-${randomBytes(4).toString('hex')}`
  return { videoUrl: `${base}/${room}`, videoProvider: 'JITSI' }
}
