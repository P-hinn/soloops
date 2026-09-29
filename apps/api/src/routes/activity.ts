import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { activitySampleBatch } from '@soloops/shared'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { buildRuns } from '../services/activity.js'
import { partsInZone, zonedToUtc } from '../services/tz.js'

/**
 * Rohe Stichproben vom Mac.
 *
 * Die Desktop-App schickt im Minutentakt, was sie gesammelt hat; hier wird es
 * abgelegt und für die Anzeige zu Abschnitten zusammengezogen. Zuordnung zu
 * Projekten passiert noch nicht — das ist die nächste Etappe.
 */

/** Kalendertag in der eingestellten Zone, nicht in UTC. */
function dayBounds(date: string): { from: Date; to: Date } {
  const [y, mo, d] = date.split('-')
  // Die Zone rechnet Ueberlaeufe selbst: der 32. Maerz ist der 1. April.
  const midnight = { y: Number(y), mo: Number(mo), d: Number(d), h: 0, mi: 0, s: 0 }
  return {
    from: zonedToUtc(midnight, env.TZ),
    to: zonedToUtc({ ...midnight, d: midnight.d + 1 }, env.TZ),
  }
}

const dayQuery = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})

const rangeQuery = z.object({
  from: z.string().datetime({ offset: true }).or(z.string().datetime()),
  to: z.string().datetime({ offset: true }).or(z.string().datetime()),
})

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  /**
   * Stichproben annehmen. Die Desktop-App sendet gepuffert und wiederholt den
   * Puffer, wenn die API weg war — Duplikate fängt der eindeutige Zeitpunkt ab.
   */
  app.post('/samples', async (req, reply) => {
    const { samples } = activitySampleBatch.parse(req.body)
    if (!samples.length) return { accepted: 0 }

    const { count } = await prisma.activitySample.createMany({
      data: samples.map((s) => ({
        at: new Date(s.atMs),
        bundleId: s.bundleId,
        appName: s.appName,
        title: s.redacted ? '' : s.title,
        redacted: s.redacted,
        idleSec: s.idleSec,
      })),
      skipDuplicates: true,
    })
    return reply.code(201).send({ accepted: count })
  })

  /** Ein Tag als Abschnitte, dazu die Summen je App. */
  app.get('/day', async (req) => {
    const { date } = dayQuery.parse(req.query)
    const today = partsInZone(new Date(), env.TZ)
    const day =
      date ?? `${today.y}-${String(today.mo).padStart(2, '0')}-${String(today.d).padStart(2, '0')}`
    const { from, to } = dayBounds(day)

    const samples = await prisma.activitySample.findMany({
      where: { at: { gte: from, lt: to } },
      orderBy: { at: 'asc' },
      select: {
        at: true,
        bundleId: true,
        appName: true,
        title: true,
        redacted: true,
        idleSec: true,
      },
    })

    const runs = buildRuns(samples, env.ACTIVITY_SAMPLE_SECONDS, env.ACTIVITY_IDLE_THRESHOLD_SEC)

    const perApp = new Map<string, { bundleId: string; appName: string; seconds: number }>()
    let activeSeconds = 0
    let idleSeconds = 0
    for (const run of runs) {
      if (run.idle) {
        idleSeconds += run.seconds
        continue
      }
      activeSeconds += run.seconds
      const entry = perApp.get(run.bundleId) ?? {
        bundleId: run.bundleId,
        appName: run.appName,
        seconds: 0,
      }
      entry.seconds += run.seconds
      perApp.set(run.bundleId, entry)
    }

    const last = await prisma.activitySample.findFirst({
      orderBy: { at: 'desc' },
      select: { at: true },
    })

    return {
      date: day,
      sampleSeconds: env.ACTIVITY_SAMPLE_SECONDS,
      idleAfterSec: env.ACTIVITY_IDLE_THRESHOLD_SEC,
      retentionDays: env.ACTIVITY_RETENTION_DAYS,
      /// Ohne Stichproben lässt sich nicht unterscheiden, ob nichts passiert
      /// ist oder niemand aufzeichnet. Die Oberfläche braucht beides.
      lastSampleAt: last?.at.toISOString() ?? null,
      activeSeconds,
      idleSeconds,
      runs,
      apps: [...perApp.values()].sort((a, b) => b.seconds - a.seconds),
    }
  })

  /** Zeitraum vergessen. Der schnellste Weg, etwas wieder loszuwerden. */
  app.delete('/', async (req) => {
    const { from, to } = rangeQuery.parse(req.query)
    const { count } = await prisma.activitySample.deleteMany({
      where: { at: { gte: new Date(from), lte: new Date(to) } },
    })
    return { deleted: count }
  })
}

export default routes
