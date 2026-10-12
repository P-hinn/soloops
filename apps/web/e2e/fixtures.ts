import { test as kit } from '@soloops/e2e'
import { mockApi, signIn, type Mocks } from './mock-api'

export { expect } from '@soloops/e2e'

/**
 * `test` with a mocked API. `mocks` overrides individual endpoints per file or
 * per test (`test.use({ mocks: { … } })`), `signedIn` starts logged in.
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
