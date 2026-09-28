import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { prisma } from '../db.js'
import { env } from '../env.js'

/**
 * Einrichtungsstand — abgeleitet aus dem, was wirklich da ist.
 *
 * Bewusst keine abhakbaren Häkchen: eine Checkliste, die man selbst abhaken
 * kann, sagt nach zwei Wochen nichts mehr über den tatsächlichen Zustand aus.
 * Jeder Schritt hier fragt die Datenbank oder die Konfiguration.
 */

type Step = {
  id: string
  title: string
  why: string
  done: boolean
  /** Ohne diesen Schritt fehlt dem Werkzeug ein Kernstück. */
  essential: boolean
  action: { label: string; url: string } | null
  /** Was zu tun ist, wenn es nicht in der UI geht (z.B. .env). */
  hint?: string
}

const SETTING_DISMISSED = 'onboarding.dismissed'
const SETTING_TOUR_SEEN = 'onboarding.tourSeen'

async function flag(key: string): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({ where: { key } })
  return row?.value === true
}

async function setFlag(key: string, value: boolean): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async () => {
    const [
      clients,
      projects,
      timeEntries,
      meetings,
      notes,
      invoices,
      calendarAccounts,
      monitors,
      repos,
      dismissed,
      tourSeen,
    ] = await Promise.all([
      prisma.client.count(),
      prisma.project.count(),
      prisma.timeEntry.count(),
      prisma.meeting.count(),
      prisma.note.count(),
      prisma.invoice.count(),
      prisma.calendarAccount.count({ where: { enabled: true } }),
      prisma.monitor.count(),
      prisma.pipelineRepo.count(),
      flag(SETTING_DISMISSED),
      flag(SETTING_TOUR_SEEN),
    ])

    // Rechnungen brauchen eine vollständige Absenderadresse — sonst ist das PDF
    // formal unbrauchbar. Steuernummer *oder* USt-IdNr. reicht.
    const companyComplete =
      !!env.COMPANY_STREET &&
      !!env.COMPANY_ZIP &&
      !!env.COMPANY_CITY &&
      !!(env.COMPANY_VAT_ID || env.COMPANY_TAX_NUMBER) &&
      !!env.COMPANY_IBAN

    const steps: Step[] = [
      {
        id: 'company',
        title: 'Absenderdaten vervollständigen',
        why: 'Ohne Adresse, Steuernummer und IBAN ist eine Rechnung formal unvollständig.',
        done: companyComplete,
        essential: true,
        action: null,
        hint: 'COMPANY_STREET, COMPANY_ZIP, COMPANY_CITY, COMPANY_TAX_NUMBER (oder COMPANY_VAT_ID) und COMPANY_IBAN in der .env, danach `docker compose up -d`.',
      },
      {
        id: 'client',
        title: 'Ersten Kunden anlegen',
        why: 'Kunde trägt Stundensatz und Zahlungsziel — beides zieht die Rechnung daraus.',
        done: clients > 0,
        essential: true,
        action: { label: 'Kunden öffnen', url: '/clients' },
      },
      {
        id: 'project',
        title: 'Erstes Projekt anlegen',
        why: 'Alles hängt am Projekt: Zeiten, Notizen, Meetings, Monitore, Rechnungen.',
        done: projects > 0,
        essential: true,
        action: { label: 'Projekte öffnen', url: '/projects' },
      },
      {
        id: 'time',
        title: 'Zeit erfassen',
        why: 'Der Timer ist die Grundlage der Abrechnung. Einmal starten und stoppen genügt.',
        done: timeEntries > 0,
        essential: true,
        action: { label: 'Zeiten öffnen', url: '/time' },
      },
      {
        id: 'invoice',
        title: 'Rechnung aus Zeiten erzeugen',
        why: 'Zeigt, ob Absenderdaten, Stundensatz und PDF zusammenpassen — vor der ersten echten Rechnung.',
        done: invoices > 0,
        essential: true,
        action: { label: 'Rechnungen öffnen', url: '/invoices' },
      },
      {
        id: 'ai',
        title: 'Anthropic-Schlüssel hinterlegen',
        why: 'Schaltet Schnelleingabe, Projekt-Lageberichte und Meeting-Zusammenfassungen frei.',
        done: !!env.ANTHROPIC_API_KEY,
        essential: false,
        action: null,
        hint: 'ANTHROPIC_API_KEY in der .env setzen.',
      },
      {
        id: 'calendar',
        title: 'Kalender verbinden',
        why: 'Google oder Apple, in beide Richtungen — damit Termine dort landen, wo du sie ohnehin ansiehst.',
        done: calendarAccounts > 0,
        essential: false,
        action: { label: 'Einstellungen öffnen', url: '/settings' },
      },
      {
        id: 'meeting',
        title: 'Meeting mit Videoraum anlegen',
        why: 'Raum, Kalendereintrag und Mitschrift entstehen in einem Schritt.',
        done: meetings > 0,
        essential: false,
        action: { label: 'Meetings öffnen', url: '/meetings' },
      },
      {
        id: 'ops',
        title: 'Betrieb anbinden',
        why: 'UptimeRobot-Monitore und CI-Repos landen dann in der Projektübersicht.',
        done: monitors > 0 || repos > 0,
        essential: false,
        action: { label: 'Betrieb öffnen', url: '/ops' },
      },
      {
        id: 'notes',
        title: 'Erste Notiz schreiben',
        why: 'Notizen sind das Gedächtnis — die Volltextsuche findet sie später samt Mails.',
        done: notes > 0,
        essential: false,
        action: { label: 'Notizen öffnen', url: '/notes' },
      },
    ]

    const essential = steps.filter((s) => s.essential)
    return {
      dismissed,
      tourSeen,
      steps,
      done: steps.filter((s) => s.done).length,
      total: steps.length,
      essentialDone: essential.filter((s) => s.done).length,
      essentialTotal: essential.length,
      /** Der nächste sinnvolle Schritt: Pflicht vor Kür. */
      next: (essential.find((s) => !s.done) ?? steps.find((s) => !s.done))?.id ?? null,
    }
  })

  app.post('/dismiss', async (req) => {
    const body = z.object({ dismissed: z.boolean().default(true) }).parse(req.body ?? {})
    await setFlag(SETTING_DISMISSED, body.dismissed)
    return { dismissed: body.dismissed }
  })

  app.post('/tour-seen', async (req) => {
    const body = z.object({ seen: z.boolean().default(true) }).parse(req.body ?? {})
    await setFlag(SETTING_TOUR_SEEN, body.seen)
    return { tourSeen: body.seen }
  })
}

export default routes
