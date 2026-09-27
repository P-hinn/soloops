name: E2E

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
    inputs:
      base_url:
        description: 'Gegen eine laufende Umgebung testen (leer = lokal bauen)'
        required: false

concurrency:
  group: e2e-${{ github.ref }}
  cancel-in-progress: true

jobs:
  e2e:
    name: ${{ matrix.browser }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
    strategy:
      fail-fast: false
      matrix:
        include:
          - { browser: chromium, engine: chromium }
          - { browser: firefox, engine: firefox }
          - { browser: webkit, engine: webkit }
          - { browser: mobile-chrome, engine: chromium }
          - { browser: mobile-safari, engine: webkit }
    steps:
      - uses: actions/checkout@v5
{{PM_SETUP}}      - uses: actions/setup-node@v5
        with:
          node-version: 22{{CACHE}}
      - run: {{PM_INSTALL}}
      - name: Browser installieren
        run: {{PM_EXEC}} playwright install --with-deps ${{ matrix.engine }}
      - name: Tests
        run: {{PM_EXEC}} playwright test --project=${{ matrix.browser }}
        env:
          E2E_BASE_URL: ${{ inputs.base_url }}
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: report-${{ matrix.browser }}
          path: |
            playwright-report/
            test-results/
          retention-days: 14
