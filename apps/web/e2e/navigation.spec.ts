import { expect, test } from './fixtures'

const PAGES = [
  ['Kalender', '/calendar'],
  ['Meetings', '/meetings'],
  ['Notizen', '/notes'],
  ['Projekte', '/projects'],
  ['Zeiten', '/time'],
  ['Rechnungen', '/invoices'],
  ['Buchhaltung', '/accounting'],
  ['Kunden', '/clients'],
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
