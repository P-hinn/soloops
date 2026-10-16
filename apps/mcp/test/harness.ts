/**
 * Every tool the MCP server registers, without starting a server.
 *
 * The register functions take an `McpServer` and call `server.tool(...)` on
 * it. This stands in for that server and keeps what it is handed, so a test
 * can look at the tools rather than at the code that defines them.
 */
import { registerOverview } from '../src/tools/overview.js'
import { registerClients } from '../src/tools/clients.js'
import { registerProjects } from '../src/tools/projects.js'
import { registerCalendar } from '../src/tools/calendar.js'
import { registerMeetings } from '../src/tools/meetings.js'
import { registerTasks } from '../src/tools/tasks.js'
import { registerNotes } from '../src/tools/notes.js'
import { registerTime } from '../src/tools/time.js'
import { registerMoney } from '../src/tools/money.js'
import { registerLeads } from '../src/tools/leads.js'
import { registerMail } from '../src/tools/mail.js'
import { registerAutomations } from '../src/tools/automations.js'

export type CollectedTool = {
  description: string
  shape: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

export async function registerAll(): Promise<[string, CollectedTool][]> {
  const collected: [string, CollectedTool][] = []

  const server = {
    tool(
      name: string,
      description: string,
      shape: Record<string, unknown>,
      handler: (args: Record<string, unknown>) => Promise<unknown>,
    ) {
      collected.push([name, { description, shape, run: handler }])
    },
  }

  // The register functions only ever use `.tool`, which is what makes this
  // stand-in enough.
  const as = server as never
  registerOverview(as)
  registerClients(as)
  registerProjects(as)
  registerCalendar(as)
  registerMeetings(as)
  registerTasks(as)
  registerNotes(as)
  registerTime(as)
  registerMoney(as)
  registerLeads(as)
  registerMail(as)
  registerAutomations(as)

  return collected
}
