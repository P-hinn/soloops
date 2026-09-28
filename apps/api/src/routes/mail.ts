import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { seal } from '../services/secretbox.js'
import { testConnection } from '../services/imap.js'
import { leadFromMail, syncMailAccount, syncAllMailAccounts } from '../services/mailSync.js'
import { touchLead } from '../services/leads.js'
import { syncWindowStart } from '../services/mailRules.js'

const accountInput = z.object({
  label: z.string().min(1),
  email: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().default(993),
  imapSecure: z.coerce.boolean().default(true),
  imapUser: z.string().min(1),
  password: z.string().min(1),
  folders: z.array(z.string()).optional(),
})

/** Das verschlüsselte Passwort verlässt die API nie. */
const publicAccount = {
  id: true,
  label: true,
  email: true,
  imapHost: true,
  imapPort: true,
  imapSecure: true,
  imapUser: true,
  folders: true,
  syncSince: true,
  enabled: true,
  lastSyncAt: true,
  lastError: true,
} as const

/** Startpunkt eines frisch verbundenen Kontos — nie vor der globalen Grenze. */
function backfillStart(): Date {
  return syncWindowStart(
    new Date(Date.now() - env.MAIL_BACKFILL_DAYS * 86_400_000),
    env.MAIL_SYNC_FROM,
  )
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  // --- Konten --------------------------------------------------------------

  app.get('/accounts', async () =>
    prisma.mailAccount.findMany({ select: publicAccount, orderBy: { createdAt: 'asc' } }),
  )

  app.post('/accounts', async (req, reply) => {
    const data = accountInput.parse(req.body)
    const email = data.email.toLowerCase()

    const credentials = {
      label: data.label,
      email,
      imapHost: data.imapHost,
      imapPort: data.imapPort,
      imapSecure: data.imapSecure,
      imapUser: data.imapUser,
      imapPassEnc: seal(data.password),
      ...(data.folders ? { folders: data.folders } : {}),
    }

    // Erst anmelden, dann speichern. Andernfalls bliebe nach einem Tippfehler
    // im Passwort ein totes Konto zurück, das den zweiten Versuch blockiert.
    const test = await testConnection(credentials)
    if (!test.ok) {
      return reply.code(400).send({ error: `Anmeldung fehlgeschlagen: ${test.error}` })
    }

    // Dieselbe Adresse noch einmal verbinden heißt: Zugangsdaten erneuern.
    const account = await prisma.mailAccount.upsert({
      where: { email },
      create: {
        ...credentials,
        folders: data.folders ?? ['INBOX'],
        syncSince: backfillStart(),
      },
      update: { ...credentials, enabled: true, lastError: null },
      select: publicAccount,
    })

    return reply.code(201).send({ ...account, availableFolders: test.folders })
  })

  app.patch('/accounts/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const data = accountInput.partial().parse(req.body)
    const { password, ...rest } = data
    return prisma.mailAccount.update({
      where: { id },
      data: { ...rest, ...(password ? { imapPassEnc: seal(password) } : {}) },
      select: publicAccount,
    })
  })

  app.delete('/accounts/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    await prisma.mailAccount.delete({ where: { id } })
    return reply.code(204).send()
  })

  app.post('/accounts/:id/sync', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    return syncMailAccount(id)
  })

  app.post('/sync', async () => syncAllMailAccounts())

  // --- Posteingang ---------------------------------------------------------

  app.get('/', async (req) => {
    const q = z
      .object({
        category: z.enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER']).optional(),
        leadId: z.string().optional(),
        unassigned: z.coerce.boolean().optional(),
        handled: z.coerce.boolean().optional(),
        take: z.coerce.number().max(200).default(50),
      })
      .parse(req.query)

    return prisma.mailMessage.findMany({
      where: {
        ...(q.category ? { category: q.category } : {}),
        ...(q.leadId ? { leadId: q.leadId } : {}),
        ...(q.handled === undefined ? {} : { handled: q.handled }),
        ...(q.unassigned ? { leadId: null, clientId: null, projectId: null } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: q.take,
      include: {
        lead: { select: { id: true, title: true } },
        client: { select: { id: true, name: true } },
        project: { select: { id: true, key: true } },
      },
    })
  })

  app.get('/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const mail = await prisma.mailMessage.findUnique({
      where: { id },
      include: {
        lead: { select: { id: true, title: true } },
        client: { select: { id: true, name: true } },
        project: { select: { id: true, key: true, name: true } },
      },
    })
    if (!mail) return reply.code(404).send({ error: 'Mail nicht gefunden' })
    return mail
  })

  /** Zuordnung von Hand. Überschreibt jede automatische Einordnung dauerhaft. */
  app.patch('/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const body = z
      .object({
        category: z.enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER']).optional(),
        leadId: z.string().nullish(),
        clientId: z.string().nullish(),
        projectId: z.string().nullish(),
        handled: z.boolean().optional(),
      })
      .parse(req.body)

    const mail = await prisma.mailMessage.update({
      where: { id },
      data: { ...body, assignedBy: 'MANUAL' },
    })

    if (body.leadId) {
      await touchLead(body.leadId, {
        kind: 'MAIL',
        body: `Von ${mail.fromEmail}: ${mail.subject}`,
        occurredAt: mail.sentAt,
        source: 'MANUAL',
      })
    }
    return mail
  })

  app.post('/:id/lead', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params)
    const lead = await leadFromMail(id)
    return reply.code(201).send(lead)
  })
}

export default routes
