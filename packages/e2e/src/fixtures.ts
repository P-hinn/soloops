import { test as base, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export type GuardOptions = {
  /** Konsolenfehler, die erwartet sind (z. B. ein absichtlich provozierter 404). */
  allowConsole: (string | RegExp)[]
  /** Fehlgeschlagene Requests, die erwartet sind — gegen die URL geprüft. */
  allowRequests: (string | RegExp)[]
  /** Auf `false`, um die Wache für einen Test ganz abzuschalten. */
  guard: boolean
}

export type A11yOptions = {
  /** Nur diesen Bereich prüfen (CSS-Selektor). */
  include?: string
  exclude?: string[]
  /** axe-Regeln, die bewusst nicht gelten, z. B. `color-contrast`. */
  disableRules?: string[]
  /** Ab welcher Schwere ein Befund den Test scheitern lässt. Standard: serious */
  failOn?: 'minor' | 'moderate' | 'serious' | 'critical'
}

type Fixtures = {
  /** Barrierefreiheit der aktuellen Seite prüfen (axe-core, WCAG 2.2 AA). */
  a11y: { check: (options?: A11yOptions) => Promise<void> }
  /** Automatisch aktiv: sammelt JS-Fehler und kaputte Requests, prüft am Testende. */
  _guard: void
}

const SEVERITY = ['minor', 'moderate', 'serious', 'critical'] as const

const matches = (text: string, patterns: (string | RegExp)[]) =>
  patterns.some((p) => (typeof p === 'string' ? text.includes(p) : p.test(text)))

/**
 * Das erweiterte `test`: an jede Seite hängt eine Wache, die am Ende des Tests
 * fehlschlägt, wenn
 *
 *   - ein unbehandelter JS-Fehler auftrat (`pageerror`),
 *   - `console.error` aufgerufen wurde,
 *   - ein Request mit 5xx antwortete oder gar nicht durchkam.
 *
 * Genau das sind die Fehler, die nur in *einem* Browser auftreten und beim
 * Klicken in Chrome nie auffallen: fehlende APIs, andere Datumsparser,
 * strengere CSP, Safari-eigene Eigenheiten.
 */
export const test = base.extend<GuardOptions & Fixtures>({
  allowConsole: [[], { option: true }],
  allowRequests: [[], { option: true }],
  guard: [true, { option: true }],

  _guard: [
    async ({ page, guard, allowConsole, allowRequests }, use, testInfo) => {
      const problems: string[] = []

      page.on('pageerror', (err) => {
        if (!matches(err.message, allowConsole)) problems.push(`JS-Fehler: ${err.message}`)
      })
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        const text = msg.text()
        // Chromium meldet jede 4xx-Antwort zusätzlich als Konsolenfehler. Die
        // sind oft gewollt (401 beim Login); echte Serverfehler fängt 'response'.
        if (/Failed to load resource: .*status of 4\d\d/.test(text)) return
        if (!matches(text, allowConsole)) problems.push(`console.error: ${text}`)
      })
      page.on('response', (res) => {
        if (res.status() < 500 || matches(res.url(), allowRequests)) return
        problems.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`)
      })
      page.on('requestfailed', (req) => {
        const reason = req.failure()?.errorText ?? ''
        // Abbrüche durch Navigation sind normal, kein Fehler der Seite.
        if (/abort|cancel|NS_BINDING_ABORTED/i.test(reason)) return
        if (matches(req.url(), allowRequests)) return
        problems.push(`Request fehlgeschlagen: ${req.method()} ${req.url()} (${reason})`)
      })

      await use()

      if (guard && problems.length) {
        await testInfo.attach('browser-fehler', {
          body: problems.join('\n'),
          contentType: 'text/plain',
        })
        expect(problems, `Fehler im Browser (${testInfo.project.name})`).toEqual([])
      }
    },
    { auto: true },
  ],

  a11y: async ({ page }, use, testInfo) => {
    await use({
      async check(options = {}) {
        let builder = new AxeBuilder({ page }).withTags([
          'wcag2a',
          'wcag2aa',
          'wcag21a',
          'wcag21aa',
          'wcag22aa',
        ])
        if (options.include) builder = builder.include(options.include)
        for (const selector of options.exclude ?? []) builder = builder.exclude(selector)
        if (options.disableRules?.length) builder = builder.disableRules(options.disableRules)

        const { violations } = await builder.analyze()
        const threshold = SEVERITY.indexOf(options.failOn ?? 'serious')
        const blocking = violations.filter(
          (v) => SEVERITY.indexOf(v.impact ?? 'minor') >= threshold,
        )

        if (violations.length) {
          await testInfo.attach('a11y', {
            body: JSON.stringify(violations, null, 2),
            contentType: 'application/json',
          })
        }
        const summary = blocking.map(
          (v) =>
            `[${v.impact}] ${v.id}: ${v.help} — ${v.nodes.length}× z. B. ${v.nodes[0]?.target.join(' ')}`,
        )
        expect(summary, `Barrierefreiheit auf ${page.url()}`).toEqual([])
      },
    })
  },
})

export { expect }

/**
 * Nichts ragt seitlich aus dem Viewport. Fängt die klassischen Mobile-Fehler:
 * feste Breiten, lange Wörter ohne Umbruch, Tabellen ohne Scroll-Container.
 */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return doc.scrollWidth - doc.clientWidth
  })
  expect(overflow, 'Seite scrollt horizontal (px)').toBeLessThanOrEqual(1)
}
