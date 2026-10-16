import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { loginInput, passwordInput } from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { hashPassword, verifyPassword } from '@soloops/core/passwords.js'
import { env } from '@soloops/core/env.js'
import {
  companyDetails,
  invoiceDefaults,
  serviceKeys,
  videoSettings,
} from '@soloops/core/settings.js'

const routes: FastifyPluginAsyncZod = async (app) => {
  app.post('/login', { schema: { body: loginInput } }, async (req, reply) => {
    const { email, password } = req.body
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.code(401).send({ error: 'E-Mail oder Passwort falsch' })
    }
    const token = app.jwt.sign({ sub: user.id, email: user.email })
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name },
    }
  })

  app.get('/me', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.principal?.type !== 'user') return { id: 'service', name: 'Service', email: '' }
    const user = await prisma.user.findUnique({ where: { id: req.principal.userId } })
    if (!user) return reply.code(404).send({ error: 'Nutzer nicht gefunden' })
    return { id: user.id, email: user.email, name: user.name }
  })

  app.post(
    '/password',
    { onRequest: [app.authenticate], schema: { body: passwordInput } },
    async (req, reply) => {
      if (req.principal?.type !== 'user') return reply.code(403).send({ error: 'Nur für Nutzer' })
      const body = req.body
      const user = await prisma.user.findUniqueOrThrow({ where: { id: req.principal.userId } })
      if (!(await verifyPassword(body.current, user.passwordHash))) {
        return reply.code(403).send({ error: 'Aktuelles Passwort falsch' })
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await hashPassword(body.next) },
      })
      return { ok: true }
    },
  )

  /**
   * What the interface needs to know before it renders anything.
   *
   * Read through the settings layer, not straight out of `env`: once a value
   * has been set in the interface the database is the answer, and the badges
   * under "Angebundene Dienste" have to switch over without a container
   * restart. The two that stay in `env` are Google's OAuth pair — the
   * redirect URI has to match what is registered in the Google console, and
   * a field that can disagree with that is a new class of failure.
   */
  app.get('/config', async () => {
    const invoice = await invoiceDefaults()
    const keys = await serviceKeys()
    const video = await videoSettings()
    return {
      companyName: (await companyDetails()).name,
      currency: 'EUR',
      smallBusiness: invoice.smallBusiness,
      defaultTaxRate: invoice.taxRate,
      defaultHourlyRateCents: invoice.hourlyRateCents,
      videoProvider: video.provider,
      features: {
        ai: !!keys.anthropic,
        uptime: !!keys.uptimerobot,
        github: !!keys.github,
        gitlab: !!keys.gitlab,
        lexoffice: !!keys.lexoffice,
        google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        apple: true, // CalDAV braucht keine Server-Konfiguration
        video: video.provider !== 'CUSTOM' || !!video.customUrl,
      },
    }
  })
}

export default routes
