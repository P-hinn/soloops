import type { Page, Route } from '@playwright/test'

/**
 * Die API als Attrappe, damit die Oberfläche ohne Postgres, Redis und Worker
 * in jedem Browser getestet werden kann. Geprüft wird hier das Frontend —
 * Rendering, Routing, Formulare, Browser-Eigenheiten —, nicht die Geschäftslogik.
 *
 * Streng: ein Endpunkt, den es hier nicht gibt, antwortet mit 501. Die Wache
 * aus dem Kit lässt den Test daran scheitern — eine neue API-Nutzung im
 * Frontend fällt also sofort auf, statt still mit leeren Daten durchzulaufen.
 */

const now = new Date()
const iso = (offsetMin = 0) => new Date(now.getTime() + offsetMin * 60_000).toISOString()

export const USER = { id: 'u1', email: 'owner@example.com', name: 'Philipp' }
export const PASSWORD = 'richtig'

const PROJECT = { id: 'p1', key: 'WEB', name: 'Website Relaunch', color: '#5c76ff' }
const CLIENT = { id: 'c1', name: 'Beispiel GmbH', company: 'Beispiel GmbH' }

type Handler = (route: Route, body: unknown) => unknown
export type Mocks = Record<string, unknown | Handler>

export const DEFAULT_MOCKS: Mocks = {
  'GET /api/auth/me': USER,
  'GET /api/auth/config': {
    companyName: 'Niestroj Software',
    currency: 'EUR',
    smallBusiness: false,
    defaultTaxRate: 19,
    defaultHourlyRateCents: 9500,
    features: {},
  },
  'GET /api/onboarding': {
    dismissed: true,
    tourSeen: true,
    steps: [],
    done: 0,
    total: 0,
    essentialDone: 0,
    essentialTotal: 0,
    next: null,
  },
  'GET /api/time/running': null,
  'GET /api/dashboard': {
    today: {
      events: [
        {
          id: 'e1',
          title: 'Abstimmung Relaunch',
          startsAt: iso(60),
          endsAt: iso(120),
          allDay: false,
          project: { key: PROJECT.key, color: PROJECT.color },
        },
      ],
    },
    weekEvents: [],
    upcomingMeetings: [{ id: 'm1', title: 'Kickoff', startsAt: iso(1440), client: CLIENT }],
    time: { weekSec: 54_000, monthSec: 216_000, unbilledSec: 36_000, unbilledCents: 95_000 },
    money: { openCents: 238_000, openCount: 2, overdue: [] },
    ops: { monitorsDown: [], failedRuns: [] },
    openActions: [{ id: 'a1', title: 'Angebot schicken', dueOn: null, project: { key: 'WEB' } }],
    activeProjects: 1,
  },
  'GET /api/calendar': [
    {
      id: 'e1',
      title: 'Abstimmung Relaunch',
      description: null,
      location: null,
      startsAt: iso(60),
      endsAt: iso(120),
      allDay: false,
      kind: 'MEETING',
      videoUrl: null,
      readOnly: false,
      recurring: false,
      project: PROJECT,
      client: null,
      meeting: null,
      links: [],
    },
  ],
  'GET /api/calendar/sources': [
    {
      id: 's1',
      label: 'soloops',
      provider: 'LOCAL',
      color: '#171714',
      enabled: true,
      remoteCalendarName: null,
    },
  ],
  'GET /api/calendar-accounts': {
    googleConfigured: false,
    appleUrl: 'https://caldav.icloud.com',
    syncCron: '*/10 * * * *',
    pendingDeletes: 0,
    accounts: [],
  },
  'GET /api/projects': [
    {
      ...PROJECT,
      status: 'ACTIVE',
      dueOn: null,
      client: CLIENT,
      trackedSec: 72_000,
      unbilledSec: 36_000,
    },
  ],
  'GET /api/clients': [
    {
      ...CLIENT,
      email: 'hallo@beispiel.de',
      phone: null,
      street: 'Musterstraße 1',
      zip: '10115',
      city: 'Berlin',
      vatId: null,
      hourlyRateCents: 9500,
      paymentTermDays: 14,
      lexofficeContactId: null,
      archived: false,
      _count: { projects: 1, invoices: 2 },
    },
  ],
  'GET /api/meetings': [
    {
      id: 'm1',
      title: 'Kickoff',
      startsAt: iso(1440),
      status: 'PLANNED',
      participants: ['hallo@beispiel.de'],
      project: { key: PROJECT.key, color: PROJECT.color },
      client: CLIENT,
      videoUrl: null,
      _count: { actionItems: 0 },
    },
  ],
  'GET /api/notes': [
    {
      id: 'n1',
      title: 'Anforderungen',
      body: '# Ziele\n\n- schneller\n- barrierefrei',
      tags: ['relaunch'],
      pinned: true,
      projectId: PROJECT.id,
      updatedAt: iso(-60),
      project: PROJECT,
    },
  ],
  'GET /api/notes/tags': [{ tag: 'relaunch', count: 1 }],
  'GET /api/time': [
    {
      id: 't1',
      projectId: PROJECT.id,
      description: 'Layout Startseite',
      startedAt: iso(-180),
      endedAt: iso(-60),
      durationSec: 7200,
      billable: true,
      rateCents: 9500,
      invoiceItemId: null,
      project: PROJECT,
    },
  ],
  'GET /api/time/report': {
    totalSeconds: 7200,
    totalValueCents: 19_000,
    rows: [
      {
        projectId: PROJECT.id,
        projectKey: PROJECT.key,
        projectName: PROJECT.name,
        clientName: CLIENT.name,
        hours: 2,
        valueCents: 19_000,
      },
    ],
  },
  'GET /api/invoices': {
    invoices: [
      {
        id: 'i1',
        number: `${now.getFullYear()}-001`,
        status: 'SENT',
        issueDate: iso(-7 * 1440),
        dueDate: iso(7 * 1440),
        totalCents: 238_000,
        lexofficeId: null,
        client: CLIENT,
        project: { key: PROJECT.key },
      },
    ],
    openCents: 238_000,
    paidCents: 0,
  },
  'GET /api/accounting/status': { provider: 'lexoffice', connected: false },
  'GET /api/accounting/revenue': {
    year: now.getFullYear(),
    months: [],
    totalNetCents: 0,
    totalTaxCents: 0,
    totalGrossCents: 0,
  },
  'GET /api/uptime': { configured: false, monitors: [] },
  'GET /api/pipelines/repos': { configured: { github: false, gitlab: false }, repos: [] },
  'GET /api/search': { hits: [] },

  'POST /api/auth/login': ((route, body) => {
    const { password } = body as { email: string; password: string }
    if (password !== PASSWORD) {
      return route.fulfill({ status: 401, json: { error: 'E-Mail oder Passwort falsch' } })
    }
    return { token: 'e2e-token', user: USER }
  }) satisfies Handler,
  'POST /api/time/start': { id: 't2', ...runningTimer() },
  'POST /api/time/stop': {},
}

function runningTimer() {
  return {
    projectId: PROJECT.id,
    description: '',
    billable: true,
    startedAt: iso(),
    project: PROJECT,
  }
}

/**
 * Hängt die Attrappe an die Seite. `overrides` ersetzt einzelne Endpunkte,
 * z. B. `{ 'GET /api/dashboard': { … } }` für einen Sonderfall im Test.
 */
export async function mockApi(page: Page, overrides: Mocks = {}) {
  const mocks = { ...DEFAULT_MOCKS, ...overrides }

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    const key = `${request.method()} ${pathname}`

    if (!(key in mocks)) {
      return route.fulfill({ status: 501, json: { error: `Nicht gemockt: ${key}` } })
    }

    const entry = mocks[key]
    if (typeof entry !== 'function') return route.fulfill({ json: entry })

    const body = request.postData() ? request.postDataJSON() : undefined
    const result = await (entry as Handler)(route, body)
    // Handler, die selbst antworten (Fehlerfälle), geben nichts zurück.
    if (result !== undefined) await route.fulfill({ json: result })
  })
}

/** Eingeloggt starten: Token liegt schon im localStorage, Rundgang ist gesehen. */
export async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem('soloops.token', 'e2e-token'))
}
