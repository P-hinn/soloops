import { defineConfig, type PlaywrightTestConfig, type Project } from '@playwright/test'
import { BROWSERS, DEFAULT_BROWSERS, resolveBrowsers, type BrowserName } from './browsers'

export type E2EOptions = {
  /** Folder holding the `*.spec.ts`, relative to the config. Default: `./e2e` */
  testDir?: string
  /** Where the app runs locally. `E2E_BASE_URL` overrides it — then no server is started. */
  baseURL: string
  /**
   * The command that starts the app (e.g. `npm run dev`). Playwright waits for
   * `baseURL` to answer and cleans up afterwards. If a server is already
   * running it is reused locally, never in CI.
   */
  webServer?: {
    command: string
    /** What to wait for if not `baseURL` (e.g. a health endpoint). */
    url?: string
    cwd?: string
    env?: Record<string, string>
    timeout?: number
  }
  /** The default selection when `E2E_BROWSERS` is unset. */
  browsers?: BrowserName[]
  /** Pass through whatever the kit does not cover. Merged last. */
  overrides?: PlaywrightTestConfig
}

const isCI = !!process.env.CI

/**
 * A Playwright config with sensible defaults for "does this work in every
 * browser?". Everything here is deliberately steerable through environment
 * variables, so the same suite runs locally, in CI and against staging or
 * production:
 *
 *   E2E_BASE_URL=https://staging.example.com   against a running environment
 *   E2E_BROWSERS=chromium,webkit                which browsers to use
 *   E2E_CHROMIUM_PATH=/path/to/chrome           your own Chromium (container)
 */
export function defineE2EConfig(options: E2EOptions) {
  // Empty counts as unset — CI passes unused inputs through as ''.
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
    // Locally a shaky test should stand out at once; in CI it should not kill
    // the build. Playwright still marks it as "flaky" in the report.
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
