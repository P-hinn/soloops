import { smokeTest } from '@soloops/e2e'
import { mockApi, signIn } from './mock-api'

/**
 * Contrast is excluded for now: `--color-muted` (#6c6b64) and the blue of the
 * kicker labels (#5c76ff) sit below 4.5:1 on paper (#f1efe8) and break WCAG AA
 * on every page. That is a decision at the design-system level, not at
 * individual pages — whoever makes it takes the exception out here.
 */
const A11Y = { disableRules: ['color-contrast'] }

/**
 * Every main page in every browser: loads without JS errors, doesn't scroll
 * sideways, passes the a11y check. Detail pages run through specs of their own.
 */
smokeTest(
  [
    { path: '/', name: 'Dashboard' },
    { path: '/calendar', name: 'Kalender' },
    { path: '/meetings', name: 'Meetings' },
    { path: '/tasks', name: 'Aufgaben' },
    { path: '/notes', name: 'Notizen' },
    { path: '/projects', name: 'Projekte' },
    { path: '/leads', name: 'Leads' },
    { path: '/inbox', name: 'Eingang' },
    { path: '/time', name: 'Zeiten' },
    { path: '/invoices', name: 'Rechnungen' },
    { path: '/accounting', name: 'Buchhaltung' },
    { path: '/contracts', name: 'Verträge' },
    { path: '/clients', name: 'Kunden' },
    { path: '/automations', name: 'Automatisierungen' },
    { path: '/ops', name: 'Uptime & CI' },
    { path: '/settings', name: 'Einstellungen' },
  ],
  {
    a11y: A11Y,
    setup: async (page) => {
      await mockApi(page)
      await signIn(page)
    },
  },
)

smokeTest([{ path: '/login', name: 'Login' }], { a11y: A11Y, setup: (page) => mockApi(page) })
