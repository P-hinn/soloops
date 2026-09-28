import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'

import { env } from './env.js'
import { ensureSearchIndexes, prisma } from './db.js'
import { registerAuth } from './auth.js'

import authRoutes from './routes/auth.js'
import clientRoutes from './routes/clients.js'
import projectRoutes from './routes/projects.js'
import calendarRoutes from './routes/calendar.js'
import meetingRoutes from './routes/meetings.js'
import noteRoutes from './routes/notes.js'
import uptimeRoutes from './routes/uptime.js'
import pipelineRoutes from './routes/pipelines.js'
import timeRoutes from './routes/time.js'
import invoiceRoutes from './routes/invoices.js'
import accountingRoutes from './routes/accounting.js'
import dashboardRoutes from './routes/dashboard.js'
import searchRoutes from './routes/search.js'
import leadRoutes from './routes/leads.js'
import mailRoutes from './routes/mail.js'
import calendarAccountRoutes from './routes/calendarAccounts.js'
import assistantRoutes from './routes/assistant.js'
import onboardingRoutes from './routes/onboarding.js'

const app = Fastify({
  logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' },
  bodyLimit: 25 * 1024 * 1024,
})

await app.register(cors, { origin: true, credentials: true })
await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '30d' } })

registerAuth(app)

app.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
  if (error instanceof ZodError) {
    return reply.code(422).send({ error: 'Validierung fehlgeschlagen', issues: error.issues })
  }
  // Prisma-Fehlermeldungen enthalten Query und Serverpfade — die gehören nicht
  // ins Frontend. Die beiden Fälle, die im Alltag vorkommen, bekommen einen
  // lesbaren Satz, alles andere bleibt im Log.
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const fields = (error.meta?.target as string[] | undefined)?.join(', ')
      return reply
        .code(409)
        .send({ error: `Eintrag existiert bereits${fields ? ` (${fields})` : ''}` })
    }
    if (error.code === 'P2025') return reply.code(404).send({ error: 'Nicht gefunden' })
    app.log.error(error)
    return reply.code(500).send({ error: 'Datenbankfehler' })
  }

  const status = typeof error.statusCode === 'number' ? error.statusCode : 500
  if (status >= 500) app.log.error(error)
  return reply.code(status).send({ error: error.message || 'Interner Fehler' })
})

app.get('/health', async () => {
  await prisma.$queryRaw`SELECT 1`
  return { ok: true, ts: new Date().toISOString() }
})

await app.register(authRoutes, { prefix: '/api/auth' })
await app.register(clientRoutes, { prefix: '/api/clients' })
await app.register(projectRoutes, { prefix: '/api/projects' })
await app.register(calendarRoutes, { prefix: '/api/calendar' })
await app.register(meetingRoutes, { prefix: '/api/meetings' })
await app.register(noteRoutes, { prefix: '/api/notes' })
await app.register(uptimeRoutes, { prefix: '/api/uptime' })
await app.register(pipelineRoutes, { prefix: '/api/pipelines' })
await app.register(timeRoutes, { prefix: '/api/time' })
await app.register(invoiceRoutes, { prefix: '/api/invoices' })
await app.register(accountingRoutes, { prefix: '/api/accounting' })
await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
await app.register(searchRoutes, { prefix: '/api/search' })
await app.register(leadRoutes, { prefix: '/api/leads' })
await app.register(mailRoutes, { prefix: '/api/mail' })
await app.register(calendarAccountRoutes, { prefix: '/api/calendar-accounts' })
await app.register(assistantRoutes, { prefix: '/api/assistant' })
await app.register(onboardingRoutes, { prefix: '/api/onboarding' })

await ensureSearchIndexes()

await app.listen({ port: env.PORT, host: '0.0.0.0' })
app.log.info(`soloops API auf :${env.PORT}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    await prisma.$disconnect()
    process.exit(0)
  })
}
