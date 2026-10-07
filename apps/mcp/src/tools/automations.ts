import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { del, get, patch, post, tool } from '../client.js'

/**
 * The automations, for Claude.
 *
 * Reading, switching and importing — but no editing of a graph. Rearranging
 * nodes through a tool call would mean a second way to author workflows that
 * has to agree with the editor forever; the editor is one click away and is
 * better at it. What Claude is genuinely useful for here is the question
 * "what stopped working and why", which is exactly what the mirror answers.
 */
export function registerAutomations(server: McpServer): void {
  tool(
    server,
    'soloops_automations',
    'Alle Automatisierungen mit Zustand: aktiv, letzter Lauf, Fehlerserie, zugeordnetes Projekt und die soloops-Events, auf die sie hören.',
    {},
    () => get('/api/automations/flows'),
  )

  tool(
    server,
    'soloops_automation_status',
    'Ist n8n erreichbar, ist der API-Key akzeptiert, wie viele Flows gibt es und wie viele scheitern gerade. Der erste Griff, wenn Automatisierungen nicht laufen.',
    {},
    () => get('/api/automations/status'),
  )

  tool(
    server,
    'soloops_automation_runs',
    'Läufe über alle Flows, neueste zuerst. Mit status=ERROR die Fehlschläge inklusive Meldung — damit lässt sich beantworten, was wann gescheitert ist.',
    {
      status: z
        .enum(['NEW', 'RUNNING', 'WAITING', 'SUCCESS', 'ERROR', 'CANCELED', 'UNKNOWN'])
        .optional()
        .describe('Nur Läufe mit diesem Ergebnis'),
      flowId: z.string().optional().describe('soloops-Id des Flows, nicht die n8n-Id'),
      take: z.number().max(200).optional(),
    },
    ({ status, flowId, take }) => get('/api/automations/runs', { status, flowId, take }),
  )

  tool(
    server,
    'soloops_automation_sync',
    'Flows und Läufe sofort aus n8n nachziehen, statt auf den Zwei-Minuten-Takt des Workers zu warten.',
    {},
    () => post('/api/automations/sync'),
  )

  tool(
    server,
    'soloops_automation_set_active',
    'Eine Automatisierung ein- oder ausschalten. Wirkt in n8n, nicht nur im Spiegel.',
    {
      id: z.string().describe('soloops-Id des Flows'),
      active: z.boolean(),
    },
    ({ id, active }) => post(`/api/automations/flows/${id}/active`, { active }),
  )

  tool(
    server,
    'soloops_automation_assign_project',
    'Eine Automatisierung einem Projekt zuordnen. Das ist soloops-Wissen — n8n kennt keine Projekte.',
    {
      id: z.string().describe('soloops-Id des Flows'),
      projectId: z.string().nullable().describe('null löst die Zuordnung'),
    },
    ({ id, projectId }) => patch(`/api/automations/flows/${id}`, { projectId }),
  )

  tool(
    server,
    'soloops_automation_templates',
    'Die mitgelieferten Vorlagen: was sie tun, auf welches Event sie hören und ob schon eine daraus angelegt wurde.',
    {},
    () => get('/api/automations/templates'),
  )

  tool(
    server,
    'soloops_automation_import_template',
    'Eine Vorlage in n8n anlegen. Landet absichtlich inaktiv — das Credential muss in n8n ausgewählt werden, danach einschalten.',
    {
      slug: z.string().describe('Slug aus soloops_automation_templates'),
      projectId: z.string().nullish(),
      name: z.string().optional().describe('Abweichender Name, sonst der der Vorlage'),
    },
    ({ slug, projectId, name }) =>
      post(`/api/automations/templates/${slug}/import`, { projectId, name }),
  )

  tool(
    server,
    'soloops_automation_triggers',
    'Die registrierten Webhooks von soloops nach n8n, mit den letzten Zustellversuchen. Hier steht, ob ein Event wirklich ankommt.',
    {},
    () => get('/api/automations/triggers'),
  )

  tool(
    server,
    'soloops_automation_deliveries',
    'Das Zustellprotokoll: jeder Versuch, soloops-Events an n8n zu schicken. Mit failedOnly nur die gescheiterten.',
    {
      triggerId: z.string().optional(),
      failedOnly: z.boolean().optional(),
      take: z.number().max(200).optional(),
    },
    ({ triggerId, failedOnly, take }) =>
      get('/api/automations/deliveries', { triggerId, failedOnly, take }),
  )

  tool(
    server,
    'soloops_automation_set_trigger',
    'Einen Trigger an- oder abschalten. Anschalten setzt zugleich die Fehlerserie zurück — sonst kippt der nächste einzelne Fehlversuch ihn gleich wieder.',
    {
      id: z.string(),
      enabled: z.boolean().optional(),
      projectId: z.string().nullish().describe('Auf ein Projekt einschränken, null hebt das auf'),
    },
    ({ id, enabled, projectId }) =>
      patch(`/api/automations/triggers/${id}`, { enabled, projectId }),
  )

  tool(
    server,
    'soloops_automation_delete',
    'Eine Automatisierung löschen — in n8n und im Spiegel. Nicht rückholbar.',
    { id: z.string().describe('soloops-Id des Flows') },
    ({ id }) => del(`/api/automations/flows/${id}`),
  )
}
