import { test as kit } from '@soloops/e2e'
import { mockApi, signIn, type Mocks } from './mock-api'

export { expect } from '@soloops/e2e'

/**
 * `test` mit gemockter API. `mocks` überschreibt einzelne Endpunkte pro Datei
 * oder Test (`test.use({ mocks: { … } })`), `signedIn` startet eingeloggt.
 */
export const test = kit.extend<{ mocks: Mocks; signedIn: boolean }>({
  mocks: [{}, { option: true }],
  signedIn: [true, { option: true }],
  page: async ({ page, mocks, signedIn }, use) => {
    await mockApi(page, mocks)
    if (signedIn) await signIn(page)
    await use(page)
  },
})
