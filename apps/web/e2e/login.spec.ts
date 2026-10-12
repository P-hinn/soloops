import { expect, test } from './fixtures'
import { PASSWORD, USER } from './mock-api'

test.use({ signedIn: false })

test.describe('Anmeldung', () => {
  test('ohne Token landet man auf dem Login', async ({ page }) => {
    await page.goto('/projects')
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: 'Willkommen zurück.' })).toBeVisible()
  })

  test('falsches Passwort zeigt einen Fehler', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('E-Mail').fill(USER.email)
    await page.getByLabel('Passwort').fill('falsch')
    await page.getByRole('button', { name: /Anmelden/ }).click()

    await expect(page.getByText('Nicht angemeldet')).toBeVisible()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('richtiges Passwort führt zum Dashboard', async ({ page }) => {
    await page.goto('/login')
    await page.getByLabel('E-Mail').fill(USER.email)
    await page.getByLabel('Passwort').fill(PASSWORD)
    await page.getByRole('button', { name: /Anmelden/ }).click()

    await expect(page).toHaveURL(/\/$/)
    expect(await page.evaluate(() => localStorage.getItem('soloops.token'))).toBe('e2e-token')
  })
})
