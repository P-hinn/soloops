import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import swagger from '@fastify/swagger'
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod'
import { ZodError } from 'zod'
import { Prisma } from '@prisma/client'

import { env } from '@soloops/core/env.js'
import { ensureSearchIndexes, initSync, prisma } from '@soloops/core/db.js'
import { RuleError } from '@soloops/core/rules.js'
import { registerAuth } from './auth.js'

import authRoutes from './routes/auth.js'
import clientRoutes from './routes/clients.js'
import contactRoutes from './routes/contacts.js'
import projectRoutes from './routes/projects.js'
import calendarRoutes from './routes/calendar.js'
import meetingRoutes from './routes/meetings.js'
import noteRoutes from './routes/notes.js'
import actionItemRoutes from './routes/actionItems.js'
import claudeRoutes from './routes/claude.js'
import uptimeRoutes from './routes/uptime.js'
import pipelineRoutes from './routes/pipelines.js'
import timeRoutes from './routes/time.js'
import activityRoutes from './routes/activity.js'
import invoiceRoutes from './routes/invoices.js'
import accountingRoutes from './routes/accounting.js'
import dashboardRoutes from './routes/dashboard.js'
import searchRoutes from './routes/search.js'
import leadRoutes from './routes/leads.js'
import mailRoutes from './routes/mail.js'
import calendarAccountRoutes from './routes/calendarAccounts.js'
import assistantRoutes from './routes/assistant.js'
import onboardingRoutes from './routes/onboarding.js'
import automationRoutes from './routes/automations.js'
import automationConnectorRoutes from './routes/automationConnector.js'
import contractRoutes from './routes/contracts.js'
import syncRoutes from './routes/sync.js'

const app = Fastify({
  logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' },
  bodyLimit: 25 * 1024 * 1024,
})

// Zod validates and serialises, and the same schemas describe the API — see
// `npm run openapi`. Set before any route is registered.
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

await app.register(cors, { origin: true, credentials: true })
await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: '30d' } })
await app.register(swagger, {
  openapi: {
    info: {
      title: 'soloops',
      description:
        'Das eigene Betriebssystem für die Solo-Selbstständigkeit. Ein Besitzer, ein Token.',
      version: process.env.npm_package_version ?? '0.1.0',
    },
    servers: [{ url: `http://localhost:${env.PORT}` }],
    components: {
      securitySchemes: {
        bearer: {
          type: 'http',
          scheme: 'bearer',
          description: 'JWT aus /api/auth/login oder der SERVICE_TOKEN aus der .env',
        },
      },
    },
    security: [{ bearer: [] }],
  },
  transform: jsonSchemaTransform,
})

registerAuth(app)

app.setErrorHandler((error: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
  // A rule from the service layer. It carries the status it means, so the
  // routes do not have to translate between "not allowed" and a number.
  if (error instanceof RuleError) {
    return reply.code(error.status).send({ error: error.message })
  }
  // Validation, from either direction: a schema on the route, or a `.parse()`
  // inside a handler. Both answer 422 with the issues — the shape the
  // interface has always read, and the reason Fastify's own 400 is not let
  // through here.
  if (hasZodFastifySchemaValidationErrors(error)) {
    return reply.code(422).send({
      error: 'Validierung fehlgeschlagen',
      // The library hands the original Zod issue through under
      // `params.issue`, typed as unknown. Narrowed here rather than cast
      // blindly, so a changed shape shows up as a missing field and not as a
      // crash inside the error handler.
      issues: error.validation.map((entry) => {
        const issue = entry.params?.issue as
          { path?: unknown; message?: string; code?: string } | undefined
        return {
          path: issue?.path ?? [],
          message: issue?.message ?? entry.message ?? 'ungültig',
          code: issue?.code ?? 'invalid',
        }
      }),
    })
  }
  if (error instanceof ZodError) {
    return reply.code(422).send({ error: 'Validierung fehlgeschlagen', issues: error.issues })
  }
  // A response that does not match its own schema is our bug, not the
  // caller's. It must not read as a client error.
  if (isResponseSerializationError(error)) {
    app.log.error(
      { err: error, route: error.method + ' ' + error.url },
      'Antwort passt nicht zum Schema',
    )
    return reply.code(500).send({ error: 'Interner Fehler' })
  }
  // Prisma error messages carry the query and server paths — none of that
  // belongs in the frontend. The two cases that come up in practice get a
  // readable sentence, everything else stays in the log.
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
await app.register(contactRoutes, { prefix: '/api/contacts' })
await app.register(projectRoutes, { prefix: '/api/projects' })
await app.register(calendarRoutes, { prefix: '/api/calendar' })
await app.register(meetingRoutes, { prefix: '/api/meetings' })
await app.register(noteRoutes, { prefix: '/api/notes' })
await app.register(actionItemRoutes, { prefix: '/api/action-items' })
await app.register(claudeRoutes, { prefix: '/api/claude' })
await app.register(uptimeRoutes, { prefix: '/api/uptime' })
await app.register(pipelineRoutes, { prefix: '/api/pipelines' })
await app.register(timeRoutes, { prefix: '/api/time' })
await app.register(activityRoutes, { prefix: '/api/activity' })
await app.register(invoiceRoutes, { prefix: '/api/invoices' })
await app.register(accountingRoutes, { prefix: '/api/accounting' })
await app.register(dashboardRoutes, { prefix: '/api/dashboard' })
await app.register(searchRoutes, { prefix: '/api/search' })
await app.register(leadRoutes, { prefix: '/api/leads' })
await app.register(mailRoutes, { prefix: '/api/mail' })
await app.register(calendarAccountRoutes, { prefix: '/api/calendar-accounts' })
await app.register(assistantRoutes, { prefix: '/api/assistant' })
await app.register(onboardingRoutes, { prefix: '/api/onboarding' })
await app.register(automationRoutes, { prefix: '/api/automations' })
// The connector is its own registration rather than a branch inside the one
// above: it is the only surface an n8n automation token opens, and that is
// much easier to keep true when the two cannot share a hook by accident.
await app.register(automationConnectorRoutes, { prefix: '/api/automations/connector' })
await app.register(contractRoutes, { prefix: '/api/contracts' })
await app.register(syncRoutes, { prefix: '/api/sync' })

// Writing the API description needs the routes and nothing else — no
// database, no port. See scripts/openapi.ts.
if (!process.env.SOLOOPS_OPENAPI) {
  await ensureSearchIndexes()

  // The op log needs its device identity before the first write is served.
  const { deviceId } = await initSync('api')
  app.log.info(`Sync-Geraet ${deviceId}`)

  await app.listen({ port: env.PORT, host: '0.0.0.0' })
  app.log.info(`soloops API auf :${env.PORT}`)
}

export { app }

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close()
    await prisma.$disconnect()
    process.exit(0)
  })
}
