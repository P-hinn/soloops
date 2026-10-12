import { expect, test } from './fixtures'

/** Every entry of the sidebar, in the order it stands there. */
const PAGES = [
  ['Kalender', '/calendar'],
  ['Meetings', '/meetings'],
  ['Aufgaben', '/tasks'],
  ['Notizen', '/notes'],
  ['Projekte', '/projects'],
  ['Leads', '/leads'],
  ['Eingang', '/inbox'],
  ['Zeiten', '/time'],
  ['Rechnungen', '/invoices'],
  ['Buchhaltung', '/accounting'],
  ['Verträge', '/contracts'],
  ['Kunden', '/clients'],
  ['Automatisierungen', '/automations'],
  ['Uptime & CI', '/ops'],
  ['Einstellungen', '/settings'],
  ['Dashboard', '/'],
] as const

test('Seitenleiste führt durch alle Module', async ({ page }) => {
  await page.goto('/')
  const nav = page.getByRole('navigation').first()

  for (const [label, path] of PAGES) {
    await nav.getByRole('link', { name: label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${path.replace('/', '\\/')}$`))
  }
})

test('unbekannte Adresse führt aufs Dashboard', async ({ page }) => {
  await page.goto('/gibt-es-nicht')
  await expect(page).toHaveURL(/\/$/)
})
