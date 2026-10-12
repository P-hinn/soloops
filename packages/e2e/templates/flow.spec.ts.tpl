import { expect, test } from './kit'

/**
 * A template for a real flow. The kit's guard runs along automatically: every
 * JS error and every 5xx response fails the test.
 */
test.describe('Startseite', () => {
  test('hat eine Hauptüberschrift', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  })
})
