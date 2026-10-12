import { defineE2EConfig } from './e2e/kit'

/**
 * E2E across all browsers. Steered through environment variables:
 *
 *   E2E_BROWSERS=chromium,webkit   certain browsers only (default: all engines + mobile)
 *   E2E_BASE_URL=https://…         against a running environment instead of a local server
 */
export default defineE2EConfig({
  baseURL: 'http://localhost:{{PORT}}',
  webServer: { command: '{{COMMAND}}' },
})
