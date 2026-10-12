import { devices, type Project } from '@playwright/test'

/**
 * The browser matrix. Every entry becomes a Playwright project, and the name is
 * at the same time what you pass to `--project` or `E2E_BROWSERS`.
 *
 * The five default targets cover the three engines that still really exist
 * (Blink, Gecko, WebKit) — desktop each, plus touch devices for Blink and
 * WebKit. Mobile Safari is the important one there: on iOS *every* browser is
 * WebKit, Chrome and Firefox included.
 */
export const BROWSERS = {
  chromium: { engine: 'chromium', use: devices['Desktop Chrome'] },
  firefox: { engine: 'firefox', use: devices['Desktop Firefox'] },
  webkit: { engine: 'webkit', use: devices['Desktop Safari'] },
  'mobile-chrome': { engine: 'chromium', use: devices['Pixel 7'] },
  'mobile-safari': { engine: 'webkit', use: devices['iPhone 15'] },
  tablet: { engine: 'webkit', use: devices['iPad (gen 7)'] },

  // The branded browsers instead of the bundled builds. They need a real
  // installation (`npx playwright install chrome msedge`) and therefore only
  // run when you ask for them explicitly.
  chrome: { engine: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  edge: { engine: 'chromium', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
} as const satisfies Record<string, { engine: Engine; use: Project['use'] }>

export type Engine = 'chromium' | 'firefox' | 'webkit'
export type BrowserName = keyof typeof BROWSERS

/** What runs when nothing is specified: every engine, desktop and mobile. */
export const DEFAULT_BROWSERS: BrowserName[] = [
  'chromium',
  'firefox',
  'webkit',
  'mobile-chrome',
  'mobile-safari',
]

export function isBrowserName(name: string): name is BrowserName {
  return Object.hasOwn(BROWSERS, name)
}

/**
 * `E2E_BROWSERS=chromium,webkit` narrows the selection, `all` takes everything
 * including the branded browsers. Unknown names are an error — a typo must not
 * quietly turn into "runs on nothing".
 */
export function resolveBrowsers(
  fallback: BrowserName[],
  raw = process.env.E2E_BROWSERS,
): BrowserName[] {
  if (!raw?.trim()) return fallback
  if (raw.trim() === 'all') return Object.keys(BROWSERS) as BrowserName[]

  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const unknown = names.filter((name) => !isBrowserName(name))
  if (unknown.length) {
    throw new Error(
      `E2E_BROWSERS: unbekannt ${unknown.join(', ')} — erlaubt: ${Object.keys(BROWSERS).join(', ')}, all`,
    )
  }
  return names as BrowserName[]
}

/** Which engines `playwright install` has to fetch for a selection. */
export function installTargets(names: BrowserName[]): string[] {
  const targets = new Set<string>()
  for (const name of names) {
    if (name === 'chrome') targets.add('chrome')
    else if (name === 'edge') targets.add('msedge')
    else targets.add(BROWSERS[name].engine)
  }
  return [...targets]
}
