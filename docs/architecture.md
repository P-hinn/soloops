# Architecture

```
apps/
  api/        Fastify + Prisma + Postgres — REST API, PDF rendering, AI calls
  worker/     BullMQ — calendar and mail sync, uptime, CI/CD, the commit
              mirror behind the time entries, digests, lead scores, the n8n
              mirror and outbound event delivery
  web/        Vue 3 + Vite + Tailwind — the interface
  mcp/        MCP server (stdio) for Claude Code / Claude Desktop
  desktop/    Tauri — the same interface as a macOS app, with menu and tray
  ios/        Swift — the iPhone app and the CarPlay screen, plus the sync engine
packages/
  shared/              Zod schemas and formatters shared by API, web and MCP
  n8n-nodes-soloops/   the soloops nodes, mounted into the n8n container
  e2e/                 Playwright kit for E2E across all browsers — reusable elsewhere
```

n8n itself is a container rather than an app here — it is run, not written.
What soloops adds around it is the connector package above, a mirror of its
workflows and runs, and the event bridge; see
[Automations](automations.md).

Worker and API share the Prisma client and the service layer through relative
imports — one monorepo, one source of truth, no duplicated integrations.

`apps/ios` is the exception: it is a Swift project and not part of the npm
workspace, so it duplicates the one thing it cannot import — the list of
synced fields. A generated fixture and a parity test keep the two copies
honest, see [Device sync](device-sync.md).
