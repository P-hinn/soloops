# Tooling and conventions

```bash
npm run check      # format, lint, types and tests in one run
npm run format     # Prettier over everything
npm run lint:fix   # ESLint with autofix
npm run test       # RRULE, sales logic, activity, the op log, automations,
                   # the task board, follow-up tickets, repository links,
                   # contracts and the files at a customer (420 cases)
npm -w @soloops/desktop run test   # the Rust side of the macOS app (6 cases)
```

The Rust tests are not part of `npm run check`: they need the toolchain, and
only people who build the app need that. The same goes for the Swift ones:

```bash
bash scripts/ios-test.sh              # the sync engine on the phone (104 cases)
npm -w @soloops/core run test:sync     # the op log against a real Postgres
npm -w @soloops/core run test:invoices # invoice numbers under concurrency
npm run openapi                       # docs/openapi.json from the routes
```

`scripts/ios-test.sh` exists rather than a bare `swift test` because building
under `~/Desktop` fails at the code-signing step — files there carry extended
attributes that `codesign` refuses, and `xattr -cr` does not stick. The script
builds outside it.

**Prettier** owns formatting (no semicolons, single quotes, 100 columns),
**tsc** owns types. The **linter** only deals with what neither of them sees —
above all the **1000-line limit per file** (`max-lines`; blank lines and
comments don't count, so good documentation isn't punished). Breaking it means
you have two things in one file. Largest file right now: `CalendarView.vue` at
814 lines.

Comments and commit messages are English; the UI copy is German. Commits follow
[Conventional Commits](https://www.conventionalcommits.org/).

## Screenshots

```bash
npm run shots      # drives the mocked interface, writes docs/screenshots/
```

Not a test and deliberately not part of CI: these assert nothing, and a
changed pixel should refresh the README rather than turn a build red. They run
against the same mock the E2E suite uses, so the pictures carry example data
instead of real clients.

## E2E across all browsers

```bash
npm run e2e:install                     # once: Chromium, Firefox, WebKit
npm run e2e                             # the interface in all three engines
E2E_BROWSERS=webkit npm run e2e         # the Safari engine only
npm -w @soloops/web run e2e:ui          # interactive, with time travel
```

The tests live in [`apps/web/e2e/`](../apps/web/e2e) and need nothing but Vite —
the API is mocked ([`mock-api.ts`](../apps/web/e2e/mock-api.ts)), and strictly so:
an endpoint without a stub answers 501 and fails the test. Every test also
watches for JS errors, `console.error` and 5xx responses on the side; the smoke
tests additionally check accessibility (axe, WCAG 2.2 AA) and sideways
scrolling. In CI each browser runs as its own job
([`.github/workflows/e2e.yml`](../.github/workflows/e2e.yml)).

Two things are deliberately excluded, each with a reason in the code: **colour
contrast** (`--color-muted` and the kicker blue sit below 4.5:1 — a decision at
the design-system level) and **mobile** (there is no layout below ~1024px yet).

The kit itself ([`packages/e2e`](../packages/e2e/README.md)) is project-agnostic
and drops into any other web project:

```bash
npm run e2e:init -- ../other-project --routes /,/pricing,/contact
```

## Dependencies held back

Deliberately **not** upgraded, each with a reason:

| Package       | Current | Available      | Why not                                                          |
| ------------- | ------- | -------------- | ---------------------------------------------------------------- |
| TypeScript    | 5.9     | 7.0            | Rewritten compiler, no solid experience with `vue-tsc` yet       |
| Prisma        | 6.19    | 7.10 (8 as RC) | Large migration step; worth its own pass, not a drive-by         |
| Zod           | 3.25    | 4.4            | Changed `.default()`/`.optional()` semantics across every schema |
| `@types/node` | 22      | 26             | Has to match the container runtime, and that is Node 22          |

Known and open: `deepmerge-ts@7.1.5` under `@prisma/config` has a stack
exhaustion on recursive object graphs (GHSA-ggr8-5vv4-36mx, high). The affected
path is the Prisma **CLI** (`generate`, `migrate`), not the query engine, and it
only ever processes our own configuration — effectively no attack surface. An
npm `override` to 8.x doesn't take with npm 11; the advisory goes away with the
Prisma upgrade.
