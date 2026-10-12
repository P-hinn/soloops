#!/usr/bin/env -S npx tsx
/**
 * Drops the E2E kit into any project.
 *
 *   npx tsx packages/e2e/src/cli.ts init ../my-project
 *   npx tsx packages/e2e/src/cli.ts update ../my-project
 *
 * `init` creates what is missing: the kit under `e2e/kit/`, a Playwright
 * config, a smoke test, an example flow, a GitHub workflow, npm scripts.
 * Existing files are left alone (unless --force). `update` swaps out the kit
 * only — so improvements made here reach every project without touching its
 * tests.
 *
 * The kit is copied rather than installed as a package: no registry, no version
 * management, and afterwards the target project depends on nothing but
 * `@playwright/test` and `@axe-core/playwright`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(HERE, '..', 'templates')
const OWN_PKG = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}
/** Not copied along: the CLI itself does not belong in the target project. */
const KIT_SKIP = new Set(['cli.ts'])

type PackageJson = {
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  packageManager?: string
}
type Pm = 'npm' | 'pnpm' | 'yarn' | 'bun'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    force: { type: 'boolean', default: false },
    port: { type: 'string' },
    command: { type: 'string' },
    routes: { type: 'string' },
    'no-workflow': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
})

const [action, target = '.'] = positionals
if (values.help || (action !== 'init' && action !== 'update')) {
  console.log(`Verwendung:
  cli.ts init   [projektordner] [--port 5173] [--command "npm run dev"] [--routes /,/about] [--no-workflow] [--force]
  cli.ts update [projektordner]`)
  process.exit(values.help ? 0 : 1)
}

const root = resolve(target)
const pkgPath = join(root, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`Kein package.json in ${root} — ist das ein Webprojekt?`)
  process.exit(1)
}

const log = (verb: string, path: string) => console.log(`  ${verb.padEnd(10)} ${path}`)

function write(rel: string, content: string, overwrite = values.force) {
  const file = join(root, rel)
  const existed = existsSync(file)
  if (existed && !overwrite) return log('vorhanden', rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  log(existed ? 'erneuert' : 'neu', rel)
}

function template(name: string, vars: Record<string, string>) {
  const raw = readFileSync(join(TEMPLATES, name), 'utf8')
  // Only {{UPPERCASE}} placeholders — GitHub's ${{ … }} expressions stay as they are.
  return raw.replace(/\{\{([A-Z_]+)\}\}/g, (all, key: string) => vars[key] ?? all)
}

function copyKit() {
  for (const file of readdirSync(HERE)) {
    if (!file.endsWith('.ts') || KIT_SKIP.has(file)) continue
    const header = '// Copied from soloops/packages/e2e — change it there, then `update`.\n'
    write(join('e2e', 'kit', file), header + readFileSync(join(HERE, file), 'utf8'), true)
  }
}

function detectPm(): Pm {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun'
  return 'npm'
}

/** Default port and start command of the common frameworks. */
function detectServer(pkg: PackageJson, pm: Pm) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  const run = pm === 'npm' ? 'npm run' : pm
  const port =
    (deps.next && '3000') ||
    (deps.nuxt && '3000') ||
    (deps.astro && '4321') ||
    (deps['@angular/core'] && '4200') ||
    (deps['react-scripts'] && '3000') ||
    (deps.vite && '5173') ||
    '3000'
  const script = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : 'dev'
  return { port, command: `${run} ${script}` }
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson
console.log(`${action === 'init' ? 'Richte' : 'Aktualisiere'} E2E-Kit ein in ${root}\n`)

copyKit()

if (action === 'init') {
  const pm = detectPm()
  const server = detectServer(pkg, pm)
  const exec = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm]
  const routes = (values.routes ?? '/').split(',').map((r) => r.trim())

  write(
    'playwright.config.ts',
    template('playwright.config.ts.tpl', {
      PORT: values.port ?? server.port,
      COMMAND: values.command ?? server.command,
    }),
  )
  write(
    'e2e/smoke.spec.ts',
    template('smoke.spec.ts.tpl', { ROUTES: `[${routes.map((r) => `'${r}'`).join(', ')}]` }),
  )
  write('e2e/flow.spec.ts', template('flow.spec.ts.tpl', {}))

  if (!values['no-workflow']) {
    write(
      '.github/workflows/e2e.yml',
      template('e2e.yml.tpl', {
        // setup-node has no bun cache and would abort without a package-lock.json.
        CACHE: pm === 'bun' ? '' : `\n          cache: ${pm}`,
        PM_SETUP:
          pm === 'pnpm'
            ? // Without `packageManager` in package.json the action needs a version.
              `      - uses: pnpm/action-setup@v4\n${pkg.packageManager ? '' : '        with:\n          version: 10\n'}`
            : pm === 'bun'
              ? '      - uses: oven-sh/setup-bun@v2\n'
              : '',
        PM_INSTALL: {
          npm: 'npm ci',
          pnpm: 'pnpm install --frozen-lockfile',
          yarn: 'yarn install --immutable',
          bun: 'bun install --frozen-lockfile',
        }[pm],
        PM_EXEC: exec,
      }),
    )
  }

  // Only add scripts and dependencies, never overwrite them.
  pkg.scripts ??= {}
  const scripts: Record<string, string> = {
    e2e: 'playwright test',
    'e2e:ui': 'playwright test --ui',
    'e2e:chromium': 'playwright test --project=chromium',
    'e2e:report': 'playwright show-report',
    'e2e:install': 'playwright install --with-deps chromium firefox webkit',
  }
  for (const [name, cmd] of Object.entries(scripts)) pkg.scripts[name] ??= cmd
  pkg.devDependencies ??= {}
  for (const [name, version] of Object.entries(OWN_PKG.dependencies)) {
    if (!pkg.dependencies?.[name]) pkg.devDependencies[name] ??= version
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  log('ergänzt', 'package.json')

  const ignorePath = join(root, '.gitignore')
  const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : ''
  const missing = ['test-results/', 'playwright-report/', 'blob-report/'].filter(
    (line) => !ignore.split('\n').includes(line),
  )
  if (missing.length) {
    const sep = ignore && !ignore.endsWith('\n') ? '\n' : ''
    writeFileSync(ignorePath, ignore + sep + missing.join('\n') + '\n')
    log('ergänzt', '.gitignore')
  }

  const install = { npm: 'npm install', pnpm: 'pnpm install', yarn: 'yarn', bun: 'bun install' }[pm]
  console.log(`
Fertig. Weiter mit:
  ${install}
  ${exec} playwright install --with-deps chromium firefox webkit
  ${pm} run e2e

Port und Startbefehl in playwright.config.ts prüfen, Routen in e2e/smoke.spec.ts ergänzen.`)
}
