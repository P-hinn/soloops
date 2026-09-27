# @soloops/e2e

E2E- und Cross-Browser-Tests für jedes Webprojekt, auf Basis von Playwright.
Eine Suite, die auf Chromium, Firefox und WebKit (= Safari) läuft, dazu
Android- und iPhone-Emulation — lokal, in CI und gegen Staging oder Produktion.

## In ein Projekt einbauen

Aus dem soloops-Ordner:

```bash
npm run e2e:init -- ../mein-projekt --routes /,/preise,/kontakt
cd ../mein-projekt
npm install
npx playwright install --with-deps chromium firefox webkit
npm run e2e
```

Framework, Port und Paketmanager werden erkannt (Next, Nuxt, Astro, Angular,
Vite, CRA; npm, pnpm, yarn, bun). Optionen: `--port`, `--command "…"`,
`--no-workflow`, `--force`.

| Angelegt                    | Zweck                                                                |
| --------------------------- | -------------------------------------------------------------------- |
| `e2e/kit/`                  | das Kit, kopiert — nicht anfassen, sondern `update`                  |
| `playwright.config.ts`      | Port und Startbefehl der App                                         |
| `e2e/smoke.spec.ts`         | Liste der Routen, die in jedem Browser geprüft werden                |
| `e2e/flow.spec.ts`          | Vorlage für echte Abläufe (Login, Checkout, Formulare)               |
| `.github/workflows/e2e.yml` | ein CI-Job pro Browser, Report als Artefakt                          |
| `package.json`              | Skripte `e2e`, `e2e:ui`, `e2e:chromium`, `e2e:report`, `e2e:install` |

Verbesserungen am Kit in alle Projekte holen, ohne deren Tests anzufassen:

```bash
npm run e2e:update -- ../mein-projekt
```

## Was jeder Test automatisch prüft

Das `test` aus dem Kit hängt an jede Seite eine Wache. Der Test scheitert, wenn

- ein unbehandelter JS-Fehler auftritt,
- `console.error` aufgerufen wird,
- ein Request mit 5xx antwortet oder gar nicht durchkommt.

Das sind die Fehler, die nur in einem Browser auftreten und beim Klicken in
Chrome nie auffallen. Ausnahmen pro Datei oder Test:

```ts
test.use({
  allowConsole: [/ResizeObserver loop/],
  allowRequests: ['/analytics'],
})
test.use({ guard: false }) // ganz aus
```

`smokeTest([...])` prüft pro Route zusätzlich: HTTP-Status < 400, Titel
vorhanden, kein seitliches Scrollen, Barrierefreiheit nach WCAG 2.2 AA
(axe-core, scheitert ab „serious"). Optional Pixelvergleich mit
`{ visual: true }`.

In eigenen Tests:

```ts
import { expect, expectNoHorizontalScroll, test } from './kit'

test('Checkout', async ({ page, a11y }) => {
  await page.goto('/warenkorb')
  await page.getByRole('button', { name: 'Zur Kasse' }).click()
  await expect(page).toHaveURL(/kasse/)
  await a11y.check({ disableRules: ['color-contrast'] })
  await expectNoHorizontalScroll(page)
})
```

## Steuerung

| Variable            | Wirkung                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `E2E_BROWSERS`      | Auswahl, z. B. `chromium,webkit` — oder `all` inkl. Chrome und Edge |
| `E2E_BASE_URL`      | gegen laufende Umgebung testen, startet keinen lokalen Server       |
| `E2E_CHROMIUM_PATH` | eigenes Chromium, z. B. in Containern ohne `playwright install`     |

Browser: `chromium`, `firefox`, `webkit`, `mobile-chrome` (Pixel 7),
`mobile-safari` (iPhone 15), `tablet` (iPad), `chrome`, `edge`. Standard sind
die ersten fünf. Mobile Safari ist der wichtigste davon: auf iOS ist jeder
Browser WebKit, auch Chrome und Firefox.

In CI: `--project=<browser>` pro Job, zwei Wiederholungen, Trace beim ersten
Wiederholungsversuch, Video und Screenshot bei Fehlern, HTML-Report und
JUnit-XML als Artefakt. Im GitHub-Workflow lässt sich über „Run workflow" eine
`base_url` eingeben, um eine deployte Umgebung zu testen.
