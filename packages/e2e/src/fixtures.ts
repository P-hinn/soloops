import { test as base, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export type GuardOptions = {
  /** Console errors that are expected (e.g. a deliberately provoked 404). */
  allowConsole: (string | RegExp)[]
  /** Failed requests that are expected — matched against the URL. */
  allowRequests: (string | RegExp)[]
  /** Set to `false` to turn the guard off for a test entirely. */
  guard: boolean
}

export type A11yOptions = {
  /** Check only this part of the page (a CSS selector). */
  include?: string
  exclude?: string[]
  /** axe rules that deliberately don't apply, e.g. `color-contrast`. */
  disableRules?: string[]
  /** From which impact on a finding fails the test. Default: serious */
  failOn?: 'minor' | 'moderate' | 'serious' | 'critical'
}

type Fixtures = {
  /** Check the accessibility of the current page (axe-core, WCAG 2.2 AA). */
  a11y: { check: (options?: A11yOptions) => Promise<void> }
  /** Active automatically: collects JS errors and broken requests, asserts at the end. */
  _guard: void
}

const SEVERITY = ['minor', 'moderate', 'serious', 'critical'] as const

const matches = (text: string, patterns: (string | RegExp)[]) =>
  patterns.some((p) => (typeof p === 'string' ? text.includes(p) : p.test(text)))

/**
 * The extended `test`: every page gets a guard attached that fails at the end
 * of the test if
 *
 *   - an unhandled JS error occurred (`pageerror`),
 *   - `console.error` was called,
 *   - a request answered 5xx or didn't get through at all.
 *
 * Those are exactly the failures that happen in *one* browser only and never
 * show up while clicking around in Chrome: missing APIs, different date
 * parsers, stricter CSP, WebKit's own quirks.
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
        // Chromium reports every 4xx response as a console error on top. Those
        // are often intended (401 on login); real server errors are caught by
        // the 'response' handler.
        if (/Failed to load resource: .*status of 4\d\d/.test(text)) return
        if (!matches(text, allowConsole)) problems.push(`console.error: ${text}`)
      })
      page.on('response', (res) => {
        if (res.status() < 500 || matches(res.url(), allowRequests)) return
        problems.push(`HTTP ${res.status()}: ${res.request().method()} ${res.url()}`)
      })
      page.on('requestfailed', (req) => {
        const reason = req.failure()?.errorText ?? ''
        // Aborts caused by navigation are normal, not a fault of the page.
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
 * Nothing sticks out of the viewport sideways. Catches the classic mobile
 * mistakes: fixed widths, long words without a break, tables without a scroll
 * container.
 */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement
    return doc.scrollWidth - doc.clientWidth
  })
  expect(overflow, 'Seite scrollt horizontal (px)').toBeLessThanOrEqual(1)
}
