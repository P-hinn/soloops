import { defineE2EConfig } from '@soloops/e2e'

/**
 * The screenshots in the README, taken from the mocked interface.
 *
 * Separate from the E2E config on purpose. These are not tests — they fail
 * nothing and assert nothing — and they must not run in CI, where a changed
 * pixel would turn a documentation refresh into a red build. Against the mock
 * rather than a real instance, so the images carry example data instead of
 * somebody's clients.
 *
 *   npm run shots
 */
export default defineE2EConfig({
  testDir: './screenshots',
  baseURL: 'http://localhost:5198',
  webServer: { command: 'npx vite --port 5198 --strictPort' },
  browsers: ['chromium'],
  overrides: {
    use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
    reporter: [['list']],
  },
})
