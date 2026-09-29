import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { seal } from '../services/secretbox.js'
import * as google from '../services/google.js'
import { discoverCalendars } from '../services/caldav.js'
import { syncAccount, syncAllAccounts } from '../services/calendarSync.js'

const idParam = z.object({ id: z.string() })

/**
 * Colour palette for connected calendars. Chosen for the paper background:
 * strong enough for the bar on an event, quiet enough for the 12 % fill.
 */
const CALENDAR_PALETTE = [
  '#5c76ff', // brand blue
  '#c2410c', // rust
  '#1f7a3d', // fir
  '#7c3aed', // violet
  '#0e7490', // teal
  '#a16207', // ochre
  '#be123c', // carmine
]

/** The first connected account becomes the target — otherwise nothing lands. */
async function shouldBeDefault(): Promise<boolean> {
  return (await prisma.calendarAccount.count({ where: { isDefault: true } })) === 0
}

/** The next colour not yet taken. */
async function nextCalendarColor(): Promise<string> {
  const used = new Set(
    (await prisma.calendarAccount.findMany({ select: { color: true } })).map((a) => a.color),
  )
  return (
    CALENDAR_PALETTE.find((c) => !used.has(c)) ??
    CALENDAR_PALETTE[used.size % CALENDAR_PALETTE.length]!
  )
}

const routes: FastifyPluginAsync = async (app) => {
  // -------------------------------------------------------------------------
  // Google callback: arrives as a browser redirect and cannot carry a header.
  // Secured through the signed `state` that we issued ourselves.
  // -------------------------------------------------------------------------
  app.get('/google/callback', async (req, reply) => {
    const q = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      })
      .parse(req.query)

    const back = (params: Record<string, string>) =>
      reply.redirect(`${env.APP_URL}/settings?${new URLSearchParams(params)}`)

    if (q.error) return back({ calendar: 'error', message: q.error })
    if (!q.code || !q.state) return back({ calendar: 'error', message: 'Antwort unvollständig' })

    try {
      await app.jwt.verify(q.state)
    } catch {
      return back({ calendar: 'error', message: 'state ungültig oder abgelaufen' })
    }

    try {
      const tokens = await google.exchangeCode(q.code)
      const calendars = await google.listCalendars(tokens.accessToken)
      const primary = calendars.find((c) => c.primary) ?? calendars[0]
      if (!primary)
        return back({ calendar: 'error', message: 'Kein schreibbarer Kalender gefunden' })

      await prisma.calendarAccount.upsert({
        where: {
          provider_accountId_remoteCalendarId: {
            provider: 'GOOGLE',
            accountId: primary.id,
            remoteCalendarId: primary.id,
          },
        },
        create: {
          provider: 'GOOGLE',
          label: `Google · ${primary.summary}`,
          accountId: primary.id,
          remoteCalendarId: primary.id,
          remoteCalendarName: primary.summary,
          accessTokenEnc: seal(tokens.accessToken),
          refreshTokenEnc: tokens.refreshToken ? seal(tokens.refreshToken) : null,
          tokenExpiresAt: tokens.expiresAt,
          color: await nextCalendarColor(),
          isDefault: await shouldBeDefault(),
        },
        update: {
          accessTokenEnc: seal(tokens.accessToken),
          // On reconnect Google does not always send a refresh token — an
          // existing one must not be overwritten with null.
          ...(tokens.refreshToken ? { refreshTokenEnc: seal(tokens.refreshToken) } : {}),
          tokenExpiresAt: tokens.expiresAt,
          enabled: true,
          lastError: null,
        },
      })

      return back({ calendar: 'connected', provider: 'google' })
    } catch (err) {
      return back({ calendar: 'error', message: (err as Error).message.slice(0, 200) })
    }
  })

  // -------------------------------------------------------------------------
  // Everything else requires authentication
  // -------------------------------------------------------------------------
  app.register(async (secured) => {
    secured.addHook('onRequest', app.authenticate)

    secured.get('/', async () => {
      const accounts = await prisma.calendarAccount.findMany({
        orderBy: [{ provider: 'asc' }, { label: 'asc' }],
        include: { _count: { select: { links: true } } },
      })
      const pendingDeletes = await prisma.syncTombstone.count()

      return {
        googleConfigured: google.googleConfigured(),
        appleUrl: env.CALDAV_APPLE_URL,
        syncCron: env.CALENDAR_SYNC_CRON,
        pendingDeletes,
        accounts: accounts.map((a) => ({
          id: a.id,
          provider: a.provider,
          label: a.label,
          accountId: a.accountId,
          calendar: a.remoteCalendarName,
          color: a.color,
          direction: a.direction,
          isDefault: a.isDefault,
          allowRemoteDelete: a.allowRemoteDelete,
          enabled: a.enabled,
          lastSyncAt: a.lastSyncAt,
          lastError: a.lastError,
          linkedEvents: a._count.links,
          // Credentials never leave the server, not even partially.
          hasRefreshToken: !!a.refreshTokenEnc,
        })),
      }
    })

    // --- Google -----------------------------------------------------------

    secured.get('/google/auth-url', async (_req, reply) => {
      if (!google.googleConfigured()) {
        return reply.code(503).send({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET fehlen' })
      }
      const state = app.jwt.sign({ purpose: 'google-oauth' }, { expiresIn: '10m' })
      return { url: google.authUrl(state) }
    })

    // --- Apple / CalDAV ---------------------------------------------------

    /**
     * First look at which calendars exist — without storing anything.
     * iCloud needs an app-specific password
     * (appleid.apple.com -> Sign-In and Security -> App-Specific Passwords).
     */
    secured.post('/apple/discover', async (req, reply) => {
      const body = z
        .object({
          username: z.string().min(3),
          password: z.string().min(6),
          baseUrl: z.string().default(env.CALDAV_APPLE_URL),
        })
        .parse(req.body)
      try {
        const calendars = await discoverCalendars(body)
        return {
          calendars: calendars.map(({ href, displayName, supportsSyncCollection }) => ({
            href,
            displayName,
            supportsSyncCollection,
          })),
        }
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message })
      }
    })

    secured.post('/apple', async (req, reply) => {
      const body = z
        .object({
          username: z.string().min(3),
          password: z.string().min(6),
          baseUrl: z.string().default(env.CALDAV_APPLE_URL),
          calendarHref: z.string().min(1),
          calendarName: z.string().default('Kalender'),
          direction: z.enum(['PULL', 'PUSH', 'BOTH']).default('BOTH'),
        })
        .parse(req.body)

      const account = await prisma.calendarAccount.upsert({
        where: {
          provider_accountId_remoteCalendarId: {
            provider: 'APPLE',
            accountId: body.username,
            remoteCalendarId: body.calendarHref,
          },
        },
        create: {
          provider: 'APPLE',
          label: `Apple · ${body.calendarName}`,
          accountId: body.username,
          direction: body.direction,
          caldavBaseUrl: body.baseUrl,
          caldavUsername: body.username,
          caldavPassEnc: seal(body.password),
          remoteCalendarId: body.calendarHref,
          remoteCalendarName: body.calendarName,
          color: await nextCalendarColor(),
          isDefault: await shouldBeDefault(),
        },
        update: {
          label: `Apple · ${body.calendarName}`,
          direction: body.direction,
          caldavPassEnc: seal(body.password),
          remoteCalendarName: body.calendarName,
          enabled: true,
          lastError: null,
        },
      })
      return reply.code(201).send({ id: account.id })
    })

    // --- Administration ---------------------------------------------------

    secured.patch('/:id', async (req) => {
      const { id } = idParam.parse(req.params)
      const body = z
        .object({
          direction: z.enum(['PULL', 'PUSH', 'BOTH']).optional(),
          enabled: z.boolean().optional(),
          label: z.string().optional(),
          isDefault: z.boolean().optional(),
          allowRemoteDelete: z.boolean().optional(),
        })
        .parse(req.body)

      // Exactly one target calendar: the flag moves instead of piling up.
      if (body.isDefault === true) {
        await prisma.calendarAccount.updateMany({
          where: { id: { not: id } },
          data: { isDefault: false },
        })
      }
      return prisma.calendarAccount.update({ where: { id }, data: body })
    })

    secured.post('/:id/sync', async (req) => {
      const { id } = idParam.parse(req.params)
      return syncAccount(id)
    })

    secured.post('/sync', async () => syncAllAccounts())

    /**
     * Force a full sync by dropping the sync token. The links stay, so that
     * nothing gets created twice.
     */
    secured.post('/:id/reset-token', async (req) => {
      const { id } = idParam.parse(req.params)
      return prisma.calendarAccount.update({
        where: { id },
        data: { syncToken: null, ctag: null, lastError: null },
      })
    })

    secured.delete('/:id', async (req, reply) => {
      const { id } = idParam.parse(req.params)
      // The links go by cascade; the events stay put locally.
      await prisma.syncTombstone.deleteMany({ where: { accountId: id } })
      await prisma.calendarAccount.delete({ where: { id } })
      return reply.code(204).send()
    })
  })
}

export default routes
