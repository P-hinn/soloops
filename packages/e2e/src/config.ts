import { defineConfig, type PlaywrightTestConfig, type Project } from '@playwright/test'
import { BROWSERS, DEFAULT_BROWSERS, resolveBrowsers, type BrowserName } from './browsers'

export type E2EOptions = {
  /** Ordner mit den `*.spec.ts`, relativ zur Config. Standard: `./e2e` */
  testDir?: string
  /** Wohin die App lokal läuft. `E2E_BASE_URL` überschreibt — dann startet kein Server. */
  baseURL: string
  /**
   * Befehl, der die App startet (z. B. `npm run dev`). Playwright wartet, bis
   * `baseURL` antwortet, und räumt danach auf. Läuft schon ein Server, wird er
   * lokal wiederverwendet, in CI nie.
   */
  webServer?: {
    command: string
    /** Worauf gewartet wird, falls nicht `baseURL` (z. B. ein Health-Endpunkt). */
    url?: string
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }
  /** Standardauswahl, wenn `E2E_BROWSERS` nicht gesetzt ist. */
  browsers?: BrowserName[]
  /** Durchreichen, was das Kit nicht abdeckt. Wird zuletzt gemischt. */
  overrides?: PlaywrightTestConfig
}

const isCI = !!process.env.CI

/**
 * Eine Playwright-Config mit vernünftigen Voreinstellungen für "läuft das in
 * allen Browsern?". Alles hier ist bewusst über Umgebungsvariablen steuerbar,
 * damit dieselbe Suite lokal, in CI und gegen Staging/Produktion läuft:
 *
 *   E2E_BASE_URL=https://staging.example.com   gegen eine laufende Umgebung
 *   E2E_BROWSERS=chromium,webkit                Auswahl der Browser
 *   E2E_CHROMIUM_PATH=/pfad/zu/chrome           eigenes Chromium (Container)
 */
export function defineE2EConfig(options: E2EOptions) {
  // Leer zählt als nicht gesetzt — CI reicht ungenutzte Eingaben als '' durch.
  const remote = process.env.E2E_BASE_URL || undefined
  const baseURL = remote ?? options.baseURL
  const browsers = resolveBrowsers(options.browsers ?? DEFAULT_BROWSERS)
  const chromiumPath = process.env.E2E_CHROMIUM_PATH

  const projects: Project[] = browsers.map((name) => {
    const { engine, use } = BROWSERS[name]
    const ownBinary = chromiumPath && engine === 'chromium' && !('channel' in use)
    return {
      name,
      use: {
        ...use,
        ...(ownBinary ? { launchOptions: { executablePath: chromiumPath } } : {}),
      },
    }
  })

  return defineConfig({
    testDir: options.testDir ?? './e2e',
    outputDir: './test-results',
    fullyParallel: true,
    forbidOnly: isCI,
    // Lokal soll ein wackliger Test sofort auffallen, in CI nicht den Build killen.
    // Playwright markiert ihn trotzdem als "flaky" im Report.
    retries: isCI ? 2 : 0,
    workers: isCI ? 2 : undefined,
    timeout: 30_000,
    expect: {
      timeout: 7_000,
      toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' },
    },
    reporter: isCI
      ? [
          ['github'],
          ['list'],
          ['html', { open: 'never' }],
          ['junit', { outputFile: 'test-results/junit.xml' }],
        ]
      : [['list'], ['html', { open: 'on-failure' }]],
    use: {
      baseURL,
      locale: 'de-DE',
      timezoneId: 'Europe/Berlin',
      trace: 'on-first-retry',
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
    },
    projects,
    webServer:
      options.webServer && !remote
        ? {
            command: options.webServer.command,
            url: options.webServer.url ?? baseURL,
            cwd: options.webServer.cwd,
            env: options.webServer.env,
            timeout: options.webServer.timeout ?? 120_000,
            reuseExistingServer: !isCI,
            stdout: 'ignore',
            stderr: 'pipe',
          }
        : undefined,
    ...options.overrides,
  })
}
