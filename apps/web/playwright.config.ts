import { defineE2EConfig } from '@soloops/e2e'

/**
 * E2E for the interface, in every browser. The API is mocked
 * (`e2e/mock-api.ts`); all this needs is the Vite dev server.
 *
 *   npm run e2e                               every browser
 *   E2E_BROWSERS=chromium npm run e2e         one of them
 *   npm run e2e:ui                            interactive
 */
export default defineE2EConfig({
  baseURL: 'http://localhost:5199',
  // A port of its own, so a running `docker compose up` is not in the way.
  webServer: { command: 'npx vite --port 5199 --strictPort' },
  // Mobile deliberately not yet: the interface has no layout below ~1024px,
  // the sidebar takes half the width on a phone. As soon as there is one, add
  // 'mobile-chrome' and 'mobile-safari' here.
  browsers: ['chromium', 'firefox', 'webkit'],
})
