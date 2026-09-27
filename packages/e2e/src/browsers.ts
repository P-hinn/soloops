import { devices, type Project } from '@playwright/test'

/**
 * Die Browser-Matrix. Jeder Eintrag wird ein Playwright-Projekt, der Name ist
 * gleichzeitig das, was man an `--project` oder `E2E_BROWSERS` übergibt.
 *
 * Die fünf Standardziele decken die drei Engines ab, die es real noch gibt
 * (Blink, Gecko, WebKit) — jeweils Desktop, dazu Touch-Geräte für Blink und
 * WebKit. Mobile Safari ist dabei der wichtigste: auf iOS ist *jeder* Browser
 * WebKit, auch Chrome und Firefox.
 */
export const BROWSERS = {
  chromium: { engine: 'chromium', use: devices['Desktop Chrome'] },
  firefox: { engine: 'firefox', use: devices['Desktop Firefox'] },
  webkit: { engine: 'webkit', use: devices['Desktop Safari'] },
  'mobile-chrome': { engine: 'chromium', use: devices['Pixel 7'] },
  'mobile-safari': { engine: 'webkit', use: devices['iPhone 15'] },
  tablet: { engine: 'webkit', use: devices['iPad (gen 7)'] },

  // Markenbrowser statt der mitgelieferten Builds. Brauchen eine echte
  // Installation (`npx playwright install chrome msedge`) und laufen deshalb
  // nur, wenn man sie ausdrücklich anfordert.
  chrome: { engine: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  edge: { engine: 'chromium', use: { ...devices['Desktop Edge'], channel: 'msedge' } },
} as const satisfies Record<string, { engine: Engine; use: Project['use'] }>

export type Engine = 'chromium' | 'firefox' | 'webkit'
export type BrowserName = keyof typeof BROWSERS

/** Was ohne weitere Angabe läuft: alle Engines, Desktop und Mobil. */
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
 * `E2E_BROWSERS=chromium,webkit` schränkt ein, `all` nimmt alles inklusive
 * Markenbrowser. Unbekannte Namen sind ein Fehler — ein Tippfehler soll nicht
 * still zu "läuft auf nichts" werden.
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

/** Welche Engines `playwright install` für eine Auswahl holen muss. */
export function installTargets(names: BrowserName[]): string[] {
  const targets = new Set<string>()
  for (const name of names) {
    if (name === 'chrome') targets.add('chrome')
    else if (name === 'edge') targets.add('msedge')
    else targets.add(BROWSERS[name].engine)
  }
  return [...targets]
}
