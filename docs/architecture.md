# Architecture

```
apps/
  api/        Fastify — routes, authentication, HTTP. Nothing else.
  worker/     BullMQ — calendar and mail sync, uptime, CI/CD, the commit
              mirror behind the time entries, digests, lead scores, the n8n
              mirror and outbound event delivery
  web/        Vue 3 + Vite + Tailwind — the interface
  mcp/        MCP server (stdio) for Claude Code / Claude Desktop
  desktop/    Tauri — the same interface as a macOS app, with menu and tray
  ios/        Swift — the iPhone app and the CarPlay screen, plus the sync engine
packages/
  core/                the database, the configuration, the queues and the
                       rules — everything API and worker have in common,
                       including the Prisma schema and its migrations
  shared/              Zod schemas and formatters shared by API, web and MCP
  n8n-nodes-soloops/   the soloops nodes, mounted into the n8n container
  e2e/                 Playwright kit for E2E across all browsers — reusable elsewhere
```

n8n itself is a container rather than an app here — it is run, not written.
What soloops adds around it is the connector package above, a mirror of its
workflows and runs, and the event bridge; see
[Automations](automations.md).

## Why there is a `core` package

The API and the worker are two processes over one set of rules. They used to
share them through relative imports: `apps/worker/src/index.ts` reached into
`apps/api/src` twelve times without declaring the API as a dependency. That
resolved only because npm hoists every workspace into one `node_modules` — the
worker's own manifest was missing `fastify`, `@anthropic-ai/sdk`, `imapflow`,
`mailparser` and `pdfkit`, all of which the code it imported needed.

So the shared half moved into `@soloops/core`: `db.ts`, `env.ts`, `queue.ts`,
the 45 services, the AI calls, the automation templates, and the Prisma schema
with its migrations. `apps/api` keeps `index.ts`, `auth.ts` and `routes/`. An
ESLint rule now rejects any import that reaches from one app into another —
including `await import(...)`, which the usual rule does not see, and which
`apps/api/src/auth.ts` deliberately uses to keep a JWT from costing a database
lookup.

Two details in that package are load-bearing and easy to break:

- **`prisma` is extended exactly once.** `withSyncLog(base)` in `db.ts` wraps
  the client so every write lands in the op log; `dbRaw` is the un-extended
  client the log's own bookkeeping uses. The package exports those two and
  nothing else — a second `new PrismaClient()` anywhere would write past the
  sync.
- **`db.ts` has an import side effect.** It patches `BigInt.prototype.toJSON`,
  without which UptimeRobot's ids cannot be serialised. That is why
  `packages/core` carries no `"sideEffects": false`: tree-shaking would drop
  the patch and the failure would surface far away from its cause.

`apps/ios` is the exception: it is a Swift project and not part of the npm
workspace, so it duplicates the one thing it cannot import — the list of
synced fields. A generated fixture and a parity test keep the two copies
honest, see [Device sync](device-sync.md).
