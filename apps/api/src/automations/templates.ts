/**
 * The bundled starter automations.
 *
 * Each one is a complete n8n workflow in the shape n8n's own export produces,
 * so importing is a plain POST to its API with no translation step. They land
 * inactive: a template cannot know which credential to use — n8n credentials
 * are created inside n8n — so the first thing each needs is a human opening
 * it, picking the soloops credential and switching it on.
 *
 * Node type names must match packages/n8n-nodes-soloops exactly. Renaming a
 * node there without renaming it here produces a workflow full of question
 * marks in the editor.
 */

const TRIGGER = 'n8n-nodes-soloops.soloopsTrigger'
const ACTION = 'n8n-nodes-soloops.soloops'

export type AutomationTemplate = {
  slug: string
  name: string
  description: string
  workflow: {
    name: string
    nodes: {
      name: string
      type: string
      typeVersion: number
      position: [number, number]
      parameters?: Record<string, unknown>
    }[]
    connections: Record<string, unknown>
    settings?: Record<string, unknown>
  }
}

/** `a -> b`, the only connection shape these templates need. */
function chain(...names: string[]): Record<string, unknown> {
  const connections: Record<string, unknown> = {}
  for (let i = 0; i < names.length - 1; i++) {
    const from = names[i]
    const to = names[i + 1]
    if (!from || !to) continue
    connections[from] = { main: [[{ node: to, type: 'main', index: 0 }]] }
  }
  return connections
}

export const templates: AutomationTemplate[] = [
  {
    slug: 'won-lead-to-project',
    name: 'Gewonnener Lead wird ein Projekt',
    description:
      'Sobald ein Lead auf gewonnen springt, legt n8n das Projekt an und hängt eine ' +
      'Startaufgabe daran. Der Lead bleibt mit dem Projekt verknüpft.',
    workflow: {
      name: 'soloops · Gewonnener Lead wird ein Projekt',
      nodes: [
        {
          name: 'Lead gewonnen',
          type: TRIGGER,
          typeVersion: 1,
          position: [0, 0],
          parameters: { event: 'lead.won' },
        },
        {
          name: 'Projekt anlegen',
          type: ACTION,
          typeVersion: 1,
          position: [220, 0],
          parameters: {
            resource: 'project',
            operation: 'create',
            name: '={{ $json.data.title }}',
            // A key has to be short and unique. The lead id's tail is both.
            key: '={{ $json.data.title.substring(0, 6).toUpperCase() }}-{{ $json.data.id.slice(-4).toUpperCase() }}',
            additionalFields: { clientId: '={{ $json.data.clientId }}' },
          },
        },
        {
          name: 'Startaufgabe',
          type: ACTION,
          typeVersion: 1,
          position: [440, 0],
          parameters: {
            resource: 'task',
            operation: 'create',
            title: 'Kickoff planen',
            additionalFields: { projectId: '={{ $json.id }}' },
          },
        },
      ],
      connections: chain('Lead gewonnen', 'Projekt anlegen', 'Startaufgabe'),
      settings: { executionOrder: 'v1' },
    },
  },

  {
    slug: 'new-lead-to-chat',
    name: 'Neuer Lead in den Chat',
    description:
      'Jeder neue Lead landet als Nachricht in Slack, Telegram oder wo auch immer. ' +
      'Die HTTP-Node ist absichtlich generisch — Webhook-URL rein und fertig.',
    workflow: {
      name: 'soloops · Neuer Lead in den Chat',
      nodes: [
        {
          name: 'Lead angelegt',
          type: TRIGGER,
          typeVersion: 1,
          position: [0, 0],
          parameters: { event: 'lead.created' },
        },
        {
          name: 'In den Chat',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [220, 0],
          parameters: {
            method: 'POST',
            // Left empty on purpose: this is the one field that has to be
            // filled in by hand, and an empty one is obvious in the editor.
            url: '',
            sendBody: true,
            specifyBody: 'json',
            jsonBody:
              '={{ JSON.stringify({ text: "Neuer Lead: " + $json.data.title + " (" + ($json.data.company || "ohne Firma") + ") — " + $json.url }) }}',
          },
        },
      ],
      connections: chain('Lead angelegt', 'In den Chat'),
      settings: { executionOrder: 'v1' },
    },
  },

  {
    slug: 'stage-change-log',
    name: 'Phasenwechsel protokollieren',
    description:
      'Jeder Phasenwechsel eines Leads wird als Aktivität am Lead festgehalten — ' +
      'inklusive der Phase, aus der er kam.',
    workflow: {
      name: 'soloops · Phasenwechsel protokollieren',
      nodes: [
        {
          name: 'Phase geändert',
          type: TRIGGER,
          typeVersion: 1,
          position: [0, 0],
          parameters: { event: 'lead.stage_changed' },
        },
        {
          name: 'Aktivität schreiben',
          type: ACTION,
          typeVersion: 1,
          position: [220, 0],
          parameters: {
            resource: 'lead',
            operation: 'logActivity',
            leadId: '={{ $json.data.id }}',
            kind: 'NOTE',
            body: '={{ "Phase: " + ($json.data.previousStage || "—") + " → " + $json.data.stage }}',
          },
        },
      ],
      connections: chain('Phase geändert', 'Aktivität schreiben'),
      settings: { executionOrder: 'v1' },
    },
  },

  {
    slug: 'meeting-followup',
    name: 'Nachfassen nach dem Meeting',
    description:
      'Ein beendetes Meeting erzeugt eine Aufgabe für das Protokoll. Hängt das ' +
      'Meeting an einem Projekt, hängt die Aufgabe dort mit dran.',
    workflow: {
      name: 'soloops · Nachfassen nach dem Meeting',
      nodes: [
        {
          name: 'Meeting beendet',
          type: TRIGGER,
          typeVersion: 1,
          position: [0, 0],
          parameters: { event: 'meeting.ended' },
        },
        {
          name: 'Aufgabe anlegen',
          type: ACTION,
          typeVersion: 1,
          position: [220, 0],
          parameters: {
            resource: 'task',
            operation: 'create',
            title: '={{ "Protokoll: " + $json.data.title }}',
            additionalFields: {
              projectId: '={{ $json.projectId }}',
              meetingId: '={{ $json.data.id }}',
            },
          },
        },
      ],
      connections: chain('Meeting beendet', 'Aufgabe anlegen'),
      settings: { executionOrder: 'v1' },
    },
  },

  {
    slug: 'lost-lead-recall',
    name: 'Verlorenen Lead in sechs Monaten wieder vorlegen',
    description:
      'Ein verlorener Lead ist selten endgültig. Der Flow wartet ein halbes Jahr ' +
      'und legt dann eine Aufgabe an, den Kontakt erneut zu versuchen.',
    workflow: {
      name: 'soloops · Verlorenen Lead wieder vorlegen',
      nodes: [
        {
          name: 'Lead verloren',
          type: TRIGGER,
          typeVersion: 1,
          position: [0, 0],
          parameters: { event: 'lead.lost' },
        },
        {
          name: 'Ein halbes Jahr warten',
          type: 'n8n-nodes-base.wait',
          typeVersion: 1.1,
          position: [220, 0],
          parameters: { unit: 'days', amount: 180 },
        },
        {
          name: 'Erneut versuchen',
          type: ACTION,
          typeVersion: 1,
          position: [440, 0],
          parameters: {
            resource: 'task',
            operation: 'create',
            title: '={{ "Zweiter Versuch: " + $(\'Lead verloren\').item.json.data.title }}',
          },
        },
      ],
      connections: chain('Lead verloren', 'Ein halbes Jahr warten', 'Erneut versuchen'),
      settings: { executionOrder: 'v1' },
    },
  },

  {
    slug: 'daily-pipeline-digest',
    name: 'Pipeline-Überblick jeden Morgen',
    description:
      'Holt morgens die offenen Leads aus soloops und schickt eine Zusammenfassung ' +
      'raus. Kein soloops-Event nötig — der Zeitplan reicht.',
    workflow: {
      name: 'soloops · Pipeline-Überblick jeden Morgen',
      nodes: [
        {
          name: 'Jeden Morgen um 7',
          type: 'n8n-nodes-base.scheduleTrigger',
          typeVersion: 1.2,
          position: [0, 0],
          parameters: {
            rule: { interval: [{ field: 'cronExpression', expression: '0 7 * * 1-5' }] },
          },
        },
        {
          name: 'Offene Leads',
          type: ACTION,
          typeVersion: 1,
          position: [220, 0],
          parameters: {
            resource: 'lead',
            operation: 'getMany',
            additionalFields: { openOnly: true, limit: 50 },
          },
        },
        {
          name: 'Zusammenfassen',
          type: 'n8n-nodes-base.httpRequest',
          typeVersion: 4.2,
          position: [440, 0],
          parameters: {
            method: 'POST',
            url: '',
            sendBody: true,
            specifyBody: 'json',
            jsonBody:
              '={{ JSON.stringify({ text: $input.all().length + " offene Leads, gewichtet " + ($input.all().reduce((sum, i) => sum + (i.json.weightedCents || 0), 0) / 100).toFixed(0) + " EUR" }) }}',
          },
        },
      ],
      connections: chain('Jeden Morgen um 7', 'Offene Leads', 'Zusammenfassen'),
      settings: { executionOrder: 'v1' },
    },
  },
]
