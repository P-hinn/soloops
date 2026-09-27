import type { Page } from '@playwright/test'
import { expect, expectNoHorizontalScroll, test, type A11yOptions } from './fixtures'

export type SmokeRoute =
  | string
  | {
      path: string
      /** Anzeigename im Report, Standard ist der Pfad. */
      name?: string
      /** Woran man erkennt, dass die Seite fertig ist (Selektor oder Rolle). */
      ready?: (page: Page) => Promise<unknown>
      /** Seitenspezifische a11y-Ausnahmen, `false` schaltet ab. */
      a11y?: A11yOptions | false
    }

export type SmokeOptions = {
  /** Läuft vor jeder Seite, z. B. Login oder API-Mocks. */
  setup?: (page: Page) => Promise<void>
  /** Barrierefreiheit mitprüfen. Standard: an. */
  a11y?: A11yOptions | false
  /** Pixelvergleich gegen gespeicherte Screenshots. Standard: aus. */
  visual?: boolean
}

/**
 * Pro Route ein Test, in jedem Browser der Matrix: Seite lädt ohne Fehler,
 * hat einen Titel, scrollt nicht seitlich und besteht den a11y-Check.
 *
 *   smokeTest(['/', '/pricing', { path: '/login', a11y: false }])
 *
 * Das ist die Grundabsicherung, die jedes Projekt ohne einen einzigen eigenen
 * Test sofort bekommt. Echte Abläufe (Login, Checkout, Formulare) gehören
 * zusätzlich in eigene Specs.
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
