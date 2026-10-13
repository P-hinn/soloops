import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '../e2e/fixtures'

/**
 * One file per page, written where the README looks for them.
 *
 * `fullPage: false` throughout: a README image is read at thumbnail size, and
 * a full-page capture of a long list is a stripe nobody can see anything in.
 */
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'screenshots')

// A configured instance, because that is what the pictures are meant to show.
// Left to the defaults the quick entry renders its "set ANTHROPIC_API_KEY"
// notice, which is correct for a test and wrong for a README.
test.use({
  mocks: {
    'GET /api/auth/config': {
      companyName: 'Niestroj Software',
      currency: 'EUR',
      smallBusiness: false,
      defaultTaxRate: 19,
      defaultHourlyRateCents: 9500,
      features: { ai: true },
    },
  },
})

const PAGES = [
  ['dashboard', '/'],
  ['tasks', '/tasks'],
  ['calendar', '/calendar'],
  ['leads', '/leads'],
  ['time', '/time'],
  ['settings-iphone', '/settings'],
] as const

test.beforeAll(async () => {
  await mkdir(OUT, { recursive: true })
})

for (const [name, path] of PAGES) {
  test(`${name} fotografieren`, async ({ page }) => {
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    // The fonts decide how every line wraps; a capture before they land is a
    // picture of a different layout.
    await page.evaluate(() => document.fonts.ready)
    await expect(page).toHaveTitle(/\S/)
    await page.screenshot({ path: join(OUT, `${name}.png`) })
  })
}
