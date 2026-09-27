import { defineE2EConfig } from '@soloops/e2e'

/**
 * E2E für die Oberfläche, in allen Browsern. Die API ist gemockt
 * (`e2e/mock-api.ts`), gebraucht wird nur der Vite-Dev-Server.
 *
 *   npm run e2e                               alle Browser
 *   E2E_BROWSERS=chromium npm run e2e         nur einer
 *   npm run e2e:ui                            interaktiv
 */
export default defineE2EConfig({
  baseURL: 'http://localhost:5199',
  // Eigener Port, damit ein laufender `docker compose up` nicht im Weg ist.
  webServer: { command: 'npx vite --port 5199 --strictPort' },
  // Mobil bewusst noch nicht: die Oberfläche hat kein Layout unter ~1024px,
  // die Seitenleiste nimmt auf dem Handy die halbe Breite. Sobald es eins
  // gibt, 'mobile-chrome' und 'mobile-safari' hier ergänzen.
  browsers: ['chromium', 'firefox', 'webkit'],
})
