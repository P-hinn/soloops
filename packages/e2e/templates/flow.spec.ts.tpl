import { expect, test } from './kit'

/**
 * Vorlage für einen echten Ablauf. Die Wache aus dem Kit läuft automatisch mit:
 * jeder JS-Fehler und jede 5xx-Antwort lässt den Test scheitern.
 */
test.describe('Startseite', () => {
  test('hat eine Hauptüberschrift', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  })
})
