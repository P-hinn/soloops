import type { Page } from '@playwright/test'
import { expect, expectNoHorizontalScroll, test, type A11yOptions } from './fixtures'

export type SmokeRoute =
  | string
  | {
      path: string
      /** Display name in the report, the path by default. */
      name?: string
      /** How to tell the page has finished loading (a selector or a role). */
      ready?: (page: Page) => Promise<unknown>
      /** Page-specific a11y exceptions, `false` turns the check off. */
      a11y?: A11yOptions | false
    }

export type SmokeOptions = {
  /** Runs before every page, e.g. login or API mocks. */
  setup?: (page: Page) => Promise<void>
  /** Check accessibility as well. Default: on. */
  a11y?: A11yOptions | false
  /** Pixel comparison against stored screenshots. Default: off. */
  visual?: boolean
}

/**
 * One test per route, in every browser of the matrix: the page loads without
 * errors, has a title, doesn't scroll sideways and passes the a11y check.
 *
 *   smokeTest(['/', '/pricing', { path: '/login', a11y: false }])
 *
 * This is the baseline cover every project gets immediately, without writing a
 * single test of its own. Real flows (login, checkout, forms) belong in specs
 * of their own on top of it.
 */
export function smokeTest(routes: SmokeRoute[], options: SmokeOptions = {}) {
  test.describe('Smoke', () => {
    for (const entry of routes) {
      const route = typeof entry === 'string' ? { path: entry } : entry

      test(`${route.name ?? route.path} lädt sauber`, async ({ page, a11y }) => {
        await options.setup?.(page)

        const res = await page.goto(route.path, { waitUntil: 'domcontentloaded' })
        expect(res?.status() ?? 200, `HTTP-Status von ${route.path}`).toBeLessThan(400)

        if (route.ready) await route.ready(page)
        await page.waitForLoadState('networkidle')

        await expect(page).toHaveTitle(/\S/)
        await expectNoHorizontalScroll(page)

        const a11yOptions = route.a11y ?? options.a11y
        if (a11yOptions !== false) await a11y.check(a11yOptions ?? {})

        if (options.visual) {
          await expect(page).toHaveScreenshot({ fullPage: true })
        }
      })
    }
  })
}
