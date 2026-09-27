import { defineE2EConfig } from './e2e/kit'

/**
 * E2E über alle Browser. Steuerung über Umgebungsvariablen:
 *
 *   E2E_BROWSERS=chromium,webkit   nur bestimmte Browser (Standard: alle Engines + Mobil)
 *   E2E_BASE_URL=https://…         gegen eine laufende Umgebung statt lokalem Server
 */
export default defineE2EConfig({
  baseURL: 'http://localhost:{{PORT}}',
  webServer: { command: '{{COMMAND}}' },
})
