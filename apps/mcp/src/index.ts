#!/usr/bin/env -S npx tsx
/**
 * soloops MCP server (stdio).
 *
 * Gives Claude Code / Claude Desktop the whole dataset — reading and writing:
 * clients, projects, calendar, meetings, to-dos, notes, time, money, sales
 * pipeline and inbox. Authentication goes through the SERVICE_TOKEN against
 * the local REST API; no tool touches the database directly.
 *
 * Registering it in Claude Code:
 *   claude mcp add soloops -- npx tsx /path/to/soloops/apps/mcp/src/index.ts
 * SOLOOPS_URL and SOLOOPS_TOKEN may come from the environment; without them
 * the server falls back to the repository's .env.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { BASE_URL, TOKEN } from './client.js'
import { registerOverview } from './tools/overview.js'
import { registerClients } from './tools/clients.js'
import { registerProjects } from './tools/projects.js'
import { registerCalendar } from './tools/calendar.js'
import { registerMeetings } from './tools/meetings.js'
import { registerTasks } from './tools/tasks.js'
import { registerNotes } from './tools/notes.js'
import { registerTime } from './tools/time.js'
import { registerMoney } from './tools/money.js'
import { registerLeads } from './tools/leads.js'
import { registerMail } from './tools/mail.js'

if (!TOKEN) {
  console.error(
    'Kein Token: SOLOOPS_TOKEN oder SERVICE_TOKEN setzen — oder den Server aus dem Repo starten, dann wird die .env gelesen.',
  )
  process.exit(1)
}

const server = new McpServer({ name: 'soloops', version: '0.1.0' })

registerOverview(server)
registerClients(server)
registerProjects(server)
registerCalendar(server)
registerMeetings(server)
registerTasks(server)
registerNotes(server)
registerTime(server)
registerMoney(server)
registerLeads(server)
registerMail(server)

await server.connect(new StdioServerTransport())
console.error(`soloops MCP bereit (${BASE_URL})`)
