import type { Page, Route } from '@playwright/test'
import { reserveLine, sumReserveLines } from '@soloops/shared'

/**
 * The API as a stub, so the interface can be tested in every browser without
 * Postgres, Redis and the worker. What is checked here is the frontend —
 * rendering, routing, forms, browser quirks — not the business logic.
 *
 * Strictly so: an endpoint that doesn't exist here answers 501. The kit's guard
 * fails the test on that — so a new API call in the frontend stands out at
 * once, instead of quietly running through on empty data.
 */

const now = new Date()
const iso = (offsetMin = 0) => new Date(now.getTime() + offsetMin * 60_000).toISOString()
/** The date as the activity endpoint takes it: local day, not UTC. */
const today = () =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

export const USER = { id: 'u1', email: 'owner@example.com', name: 'Philipp' }
export const PASSWORD = 'richtig'

const PROJECT = { id: 'p1', key: 'WEB', name: 'Website Relaunch', color: '#5c76ff' }
const CLIENT = { id: 'c1', name: 'Beispiel GmbH', company: 'Beispiel GmbH' }

/**
 * The project as its own endpoint answers it — rate, budget and description
 * included. The list does not carry them, and the edit form reads them from
 * here precisely for that reason.
 */
const PROJECT_DETAIL = {
  ...PROJECT,
  description: 'Neue Startseite, neues CMS.',
  status: 'ACTIVE',
  clientId: CLIENT.id,
  hourlyRateCents: 9500,
  budgetCents: 1_800_000,
  startsOn: iso(-30 * 1440),
  dueOn: iso(30 * 1440),
  client: CLIENT,
  trackedSec: 72_000,
  unbilledSec: 36_000,
  invoicedCents: 450_000,
  monitors: [],
  repos: [],
  notes_: [],
  meetings: [],
  actionItems: [{ id: 'a1', title: 'Angebot schicken', dueOn: null, done: false, status: 'TODO' }],
  digests: [],
}

/**
 * Die Rücklagenrechnung eines Jahres, so wie `/api/reserve/:year` sie liefert:
 * Sätze, ein Kostenposten und zwölf Monate, von denen einer gefüllt ist.
 * Gerechnet wird mit derselben Funktion wie in der Anwendung — eine zweite
 * Formel im Stub würde Fehler in der echten verdecken.
 */
const RESERVE_YEAR = new Date().getFullYear()
const RESERVE_RATES = { vatRate: 19, incomeTaxRate: 35, discountRate: 0 }
const RESERVE_COST_CENTS = 50_000

function reserveView() {
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    note: null,
    // Der Januar hat Rechnungen, aber noch keinen eingetragenen Umsatz — genau
    // der Fall, für den es den Übernehmen-Knopf gibt.
    invoicedGrossCents: i === 0 ? 595_000 : 0,
    ...reserveLine(i === 2 ? 1_190_000 : 0, RESERVE_COST_CENTS, RESERVE_RATES),
  }))
  return {
    year: RESERVE_YEAR,
    exists: true,
    rates: RESERVE_RATES,
    note: null,
    costs: [
      { id: 'rc1', label: 'Büro', monthlyCents: RESERVE_COST_CENTS, note: null, position: 0 },
    ],
    costPerMonthCents: RESERVE_COST_CENTS,
    months,
    total: sumReserveLines(months),
  }
}

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

  // The settings layer, as /api/settings answers it: value, label, whether it
  // still comes from the .env, and secrets masked. One of each kind, which is
  // all the form needs to render every control.
  'GET /api/settings': {
    'company.name': {
      value: 'Niestroj Software',
      label: 'Name oder Firma',
      source: 'env',
      secret: false,
      kind: 'text',
      required: true,
      hint: 'Steht als Absender auf jeder Rechnung.',
    },
    'company.street': {
      value: 'Beispielweg 1',
      label: 'Straße und Nummer',
      source: 'env',
      secret: false,
      kind: 'text',
      required: true,
    },
    'company.zip': {
      value: '10115',
      label: 'PLZ',
      source: 'env',
      secret: false,
      kind: 'text',
      required: true,
    },
    'company.city': {
      value: 'Berlin',
      label: 'Ort',
      source: 'env',
      secret: false,
      kind: 'text',
      required: true,
    },
    'company.iban': {
      value: 'DE02 1203 0000 0000 2020 51',
      label: 'IBAN',
      source: 'db',
      secret: false,
      kind: 'iban',
      required: true,
      hint: 'Ohne Konto weiß niemand, wohin er zahlen soll.',
    },
    'invoice.smallBusiness': {
      value: false,
      label: 'Kleinunternehmer (§19 UStG)',
      source: 'env',
      secret: false,
      kind: 'switch',
      required: false,
      hint: 'An: keine Umsatzsteuer auf der Rechnung, egal welcher Satz eingestellt ist.',
    },
    'invoice.taxRate': {
      value: 19,
      label: 'Umsatzsteuer',
      source: 'env',
      secret: false,
      kind: 'percent',
      required: false,
    },
    'invoice.hourlyRateCents': {
      value: 9500,
      label: 'Stundensatz',
      source: 'env',
      secret: false,
      kind: 'money',
      required: false,
      hint: 'Gilt, wenn Projekt und Kunde keinen eigenen Satz haben.',
    },
    'invoice.paymentTermDays': {
      value: 14,
      label: 'Zahlungsziel',
      source: 'env',
      secret: false,
      kind: 'days',
      required: false,
    },
    'keys.anthropic': {
      value: { set: true, hint: 'sk-a…' },
      label: 'Anthropic',
      source: 'env',
      secret: true,
      kind: 'text',
      required: false,
      hint: 'Schaltet Schnelleingabe, Lageberichte und Lead-Bewertung frei.',
    },
    'keys.github': {
      value: { set: false, hint: '' },
      label: 'GitHub',
      source: 'env',
      secret: true,
      kind: 'text',
      required: false,
    },
    'video.provider': {
      value: 'JITSI',
      label: 'Woher der Raum kommt',
      source: 'env',
      secret: false,
      kind: 'select',
      required: false,
      options: [
        { value: 'JITSI', label: 'Jitsi — neuer Raum je Termin, ohne Konto' },
        { value: 'GOOGLE_MEET', label: 'Google Meet — braucht ein verbundenes Google-Konto' },
        { value: 'CUSTOM', label: 'Eigener Dauerraum (Zoom, Teams …)' },
      ],
    },
    'cron.mail': {
      value: '*/10 * * * *',
      label: 'Postfach abrufen',
      source: 'env',
      secret: false,
      kind: 'cron',
      required: false,
    },
    'cron.pipelines': {
      value: '7 */4 * * *',
      label: 'CI-Läufe prüfen',
      source: 'db',
      secret: false,
      kind: 'cron',
      required: false,
      hint: 'Ein eigener Ausdruck — so sieht das Feld aus, wenn die Auswahl nicht reicht.',
    },
  },
  'PATCH /api/settings': {},
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
    sales: {
      openCount: 1,
      openValueCents: 450_000,
      weightedCents: 180_000,
      stale: [],
      followUps: { due: [], next: [] },
    },
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
      clientId: CLIENT.id,
      status: 'ACTIVE',
      dueOn: null,
      client: CLIENT,
      trackedSec: 72_000,
      unbilledSec: 36_000,
    },
  ],
  'GET /api/projects/p1': PROJECT_DETAIL,
  'PATCH /api/projects/p1': ((_route, body) => ({
    ...PROJECT_DETAIL,
    ...(body as object),
  })) satisfies Handler,
  'GET /api/reserve': [{ year: RESERVE_YEAR, payoutCents: 50_000 }],
  [`GET /api/reserve/${RESERVE_YEAR}`]: reserveView(),
  [`PATCH /api/reserve/${RESERVE_YEAR}`]: (() => reserveView()) satisfies Handler,
  [`PUT /api/reserve/${RESERVE_YEAR}/months/1`]: (() => reserveView()) satisfies Handler,
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
      _count: { projects: 1, invoices: 2, contacts: 2, contracts: 2, attachments: 2 },
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
  'POST /api/notes': ((_route, body) => ({
    id: 'n2',
    ...(body as object),
    updatedAt: iso(),
  })) satisfies Handler,
  'PATCH /api/notes/n1': ((_route, body) => ({
    id: 'n1',
    ...(body as object),
    updatedAt: iso(),
  })) satisfies Handler,
  'DELETE /api/notes/n1': (() => ({})) satisfies Handler,
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
      // The real answer always carries this, even when it is empty — see
      // listTime() in packages/core. Without it here the page used to crash
      // in all three browsers.
      commits: [],
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

  'GET /api/action-items': [
    {
      id: 'a1',
      title: 'Angebot schicken',
      done: false,
      status: 'TODO',
      dueOn: null,
      assignee: null,
      source: 'MANUAL',
      position: 0,
      projectId: PROJECT.id,
      clientId: CLIENT.id,
      meetingId: null,
      leadId: null,
      createdAt: iso(-1440),
      updatedAt: iso(-60),
      project: PROJECT,
      client: { id: CLIENT.id, name: CLIENT.name },
      meeting: null,
      lead: null,
      links: [],
      trackedSec: 0,
    },
  ],
  'GET /api/leads': [
    {
      id: 'l1',
      title: 'Relaunch Shop',
      stage: 'QUALIFIED',
      source: 'MANUAL',
      company: 'Muster AG',
      contactName: 'Anna Muster',
      probability: 40,
      aiScore: null,
      expectedCloseOn: null,
      computedValueCents: 450_000,
      weightedCents: 180_000,
      staleDays: 2,
      followUpOn: null,
      followUpNote: null,
      followUpDays: null,
      client: null,
    },
  ],
  'GET /api/leads/pipeline': {
    openCount: 1,
    openValueCents: 450_000,
    weightedCents: 180_000,
    byStage: [
      {
        stage: 'QUALIFIED',
        label: 'Qualifiziert',
        count: 1,
        valueCents: 450_000,
        weightedCents: 180_000,
      },
    ],
    stale: [],
    followUps: { due: [], next: [] },
    wonThisYear: 0,
    wonValueCents: 0,
    winRate: null,
  },
  'GET /api/mail': [
    {
      id: 'mail1',
      subject: 'Anfrage Relaunch',
      fromName: 'Anna Muster',
      fromEmail: 'anna@muster.de',
      sentAt: iso(-120),
      snippet: 'wir suchen Unterstützung für unseren Shop',
      category: 'LEAD',
      assignedBy: 'RULE',
      confidence: null,
      aiReason: null,
      leadSuggestion: null,
      handled: false,
      lead: null,
      client: null,
      project: null,
    },
  ],
  'GET /api/mail/accounts': [
    {
      id: 'ma1',
      label: 'Post',
      email: 'post@example.com',
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      imapUser: 'post@example.com',
      folders: ['INBOX'],
      syncSince: iso(-30 * 1440),
      enabled: true,
      lastSyncAt: iso(-15),
      lastError: null,
    },
  ],
  // One of each kind the overview distinguishes: out for signature, and
  // signed with an end date close enough to be a warning.
  'GET /api/contracts': [
    {
      id: 'ct1',
      clientId: CLIENT.id,
      projectId: null,
      type: 'werkvertrag',
      title: 'Werkvertrag Relaunch',
      status: 'versendet',
      externalId: 'zr1',
      taskId: 't9',
      file: null,
      signedOn: null,
      startsOn: null,
      endsOn: null,
      amountCents: 1200000,
      notes: null,
      archived: false,
      createdAt: iso(-2880),
      client: { id: CLIENT.id, name: CLIENT.name, company: CLIENT.company },
      project: null,
      task: {
        id: 't9',
        title: 'Signatur ausstehend: Werkvertrag Relaunch',
        dueOn: iso(1440),
        done: false,
      },
    },
    {
      id: 'ct2',
      clientId: CLIENT.id,
      projectId: null,
      type: 'nda',
      title: 'NDA 2026',
      status: 'signiert',
      externalId: null,
      taskId: null,
      file: 'c1-2026-01-04-nda-2026-ct2.pdf',
      signedOn: iso(-400 * 1440),
      startsOn: iso(-400 * 1440),
      endsOn: iso(20 * 1440),
      amountCents: null,
      notes: 'Gegenseitig, zwei Jahre Nachlauf.',
      archived: false,
      createdAt: iso(-400 * 1440),
      client: { id: CLIENT.id, name: CLIENT.name, company: CLIENT.company },
      project: null,
      task: null,
    },
  ],
  // Two files at the customer: one the browser may show in place, one it has
  // to download — the two branches the list distinguishes.
  'GET /api/attachments': [
    {
      id: 'at1',
      clientId: CLIENT.id,
      title: 'Briefing Relaunch',
      file: 'c1-2026-02-03-briefing-relaunch-at1.pdf',
      originalName: 'Briefing_Relaunch_final.pdf',
      mime: 'application/pdf',
      sizeBytes: 1_842_000,
      notes: null,
      createdAt: iso(-60 * 1440),
      client: { id: CLIENT.id, name: CLIENT.name, company: CLIENT.company },
      project: { id: PROJECT.id, key: PROJECT.key, name: PROJECT.name },
    },
    {
      id: 'at2',
      clientId: CLIENT.id,
      title: 'Logo-Paket',
      file: 'c1-2026-02-03-logo-paket-at2.zip',
      originalName: 'logo.zip',
      mime: 'application/zip',
      sizeBytes: 8_400_000,
      notes: 'SVG und PNG, beide Varianten.',
      createdAt: iso(-30 * 1440),
      client: { id: CLIENT.id, name: CLIENT.name, company: CLIENT.company },
      project: null,
    },
  ],
  'GET /api/automations/status': {
    reachable: false,
    authorized: false,
    error: null,
    hasApiKey: false,
    hasLogin: false,
    loginEmail: null,
    editorUrl: 'http://localhost:5678',
    flows: 0,
    failing: 0,
    events: [],
  },
  'GET /api/automations/flows': [],
  'GET /api/automations/templates': [],
  'GET /api/automations/triggers': [],
  'GET /api/automations/tokens': { tokens: [], baseUrl: 'http://localhost:4000' },
  'GET /api/activity/day': {
    date: today(),
    sampleSeconds: 60,
    idleAfterSec: 300,
    retentionDays: 30,
    lastSampleAt: iso(-5),
    activeSeconds: 7200,
    idleSeconds: 1800,
    runs: [],
    apps: [],
  },
  'GET /api/claude/status': { lastSeenAt: null, entry: 'apps/mcp/src/index.ts', runner: 'tsx' },
  'GET /api/sync/devices': {
    host: 'localhost',
    port: 4100,
    addresses: ['192.168.1.10'],
    devices: [],
    ops: 0,
  },

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
 * Attaches the stub to the page. `overrides` replaces individual endpoints,
 * e.g. `{ 'GET /api/dashboard': { … } }` for a special case in a test.
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
    // Handlers that answer themselves (error cases) return nothing.
    if (result !== undefined) await route.fulfill({ json: result })
  })
}

/** Start logged in: the token is already in localStorage, the tour is seen. */
export async function signIn(page: Page) {
  await page.addInitScript(() => localStorage.setItem('soloops.token', 'e2e-token'))
}
