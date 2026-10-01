import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db.js'

/**
 * The part of the Claude connection the interface cannot see for itself.
 *
 * Writing the connector into Claude's config is the desktop app's job — the
 * API runs in a container and has no home directory to write into. What it
 * does know is whether Claude has actually been here: every call from the MCP
 * server passes through `authenticate` and leaves a timestamp.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/status', async () => {
    const seen = await prisma.appSetting.findUnique({ where: { key: 'mcp.lastSeenAt' } })
    return {
      /** Last access by the MCP server, not by the desktop app. */
      lastSeenAt: typeof seen?.value === 'string' ? seen.value : null,
      /** Where the server and its runner live inside the repository. */
      entry: 'apps/mcp/src/index.ts',
      runner: 'node_modules/tsx/dist/cli.mjs',
    }
  })
}

export default routes
