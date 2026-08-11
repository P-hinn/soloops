import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { loginInput } from '@soloops/shared'
import { prisma } from '../db.js'
import { hashPassword, verifyPassword } from '../auth.js'
import { env } from '../env.js'

const vaultSetupInput = z.object({
  vaultSalt: z.string().min(8),
  vaultCheck: z.string().min(8),
})

const routes: FastifyPluginAsync = async (app) => {
  app.post('/login', async (req, reply) => {
    const { email, password } = loginInput.parse(req.body)
    const user = await prisma.user.findUnique({ where: { email } })
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return reply.code(401).send({ error: 'E-Mail oder Passwort falsch' })
    }
    const token = app.jwt.sign({ sub: user.id, email: user.email })
    return {
      token,
      user: { id: user.id, email: user.email, name: user.name, vaultReady: !!user.vaultSalt },
    }
  })

  app.get('/me', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.principal?.type !== 'user') return { id: 'service', name: 'Service', email: '', vaultReady: false }
    const user = await prisma.user.findUnique({ where: { id: req.principal.userId } })
    if (!user) return reply.code(404).send({ error: 'Nutzer nicht gefunden' })
    return { id: user.id, email: user.email, name: user.name, vaultReady: !!user.vaultSalt }
  })

  app.post('/password', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.principal?.type !== 'user') return reply.code(403).send({ error: 'Nur für Nutzer' })
    const body = z.object({ current: z.string(), next: z.string().min(10) }).parse(req.body)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.principal.userId } })
    if (!(await verifyPassword(body.current, user.passwordHash))) {
      return reply.code(403).send({ error: 'Aktuelles Passwort falsch' })
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.next) },
    })
    return { ok: true }
  })

  // --- Vault-Metadaten -----------------------------------------------------
  // Der Server kennt nur Salt + einen Verifier-Blob. Das Master-Passwort und
  // der abgeleitete AES-Key verlassen den Browser nie.

  app.get('/vault-meta', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.principal?.type !== 'user') return reply.code(403).send({ error: 'Nur für Nutzer' })
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.principal.userId } })
    return { vaultSalt: user.vaultSalt, vaultCheck: user.vaultCheck }
  })

  app.post('/vault-meta', { onRequest: [app.authenticate] }, async (req, reply) => {
    if (req.principal?.type !== 'user') return reply.code(403).send({ error: 'Nur für Nutzer' })
    const body = vaultSetupInput.parse(req.body)
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.principal.userId } })
    if (user.vaultSalt) {
      const count = await prisma.vaultItem.count()
      if (count > 0) {
        return reply
          .code(409)
          .send({ error: `Vault enthält ${count} Einträge. Erst leeren, dann neu initialisieren.` })
      }
    }
    await prisma.user.update({ where: { id: user.id }, data: body })
    return { ok: true }
  })

  app.get('/config', async () => ({
    companyName: env.COMPANY_NAME,
    currency: 'EUR',
    smallBusiness: env.INVOICE_SMALL_BUSINESS,
    defaultTaxRate: env.INVOICE_DEFAULT_TAX_RATE,
    defaultHourlyRateCents: env.INVOICE_DEFAULT_HOURLY_RATE_CENTS,
    videoProvider: env.VIDEO_PROVIDER,
    features: {
      ai: !!env.ANTHROPIC_API_KEY,
      uptime: !!env.UPTIMEROBOT_API_KEY,
      github: !!env.GITHUB_TOKEN,
      gitlab: !!env.GITLAB_TOKEN,
      lexoffice: !!env.LEXOFFICE_API_KEY,
      google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      apple: true, // CalDAV braucht keine Server-Konfiguration
      video: env.VIDEO_PROVIDER !== 'CUSTOM' || !!env.VIDEO_CUSTOM_URL,
    },
  }))
}

export default routes
