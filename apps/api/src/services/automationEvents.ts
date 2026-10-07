import type { AutomationEvent } from '@prisma/client'

/**
 * The soloops side of the connector: what soloops sends out, and to whom.
 *
 * Only the shaping and the matching live here, no IO — that is what makes
 * both testable. The posting is in automationDelivery.ts, the enqueueing in
 * the emit helper at the bottom.
 */

/**
 * The wire names. These travel to n8n in the payload and are what the Soloops
 * Trigger node matches on, so a rename here silently stops every workflow
 * that listens for the old one. The enum is the database spelling, this is
 * the public one.
 */
export const EVENT_WIRE: Record<AutomationEvent, string> = {
  LEAD_CREATED: 'lead.created',
  LEAD_STAGE_CHANGED: 'lead.stage_changed',
  LEAD_WON: 'lead.won',
  LEAD_LOST: 'lead.lost',
  PROJECT_CREATED: 'project.created',
  MEETING_ENDED: 'meeting.ended',
  TASK_COMPLETED: 'task.completed',
  NOTE_CREATED: 'note.created',
}

/** What the interface and the node palette call each event. */
export const EVENT_LABEL: Record<AutomationEvent, string> = {
  LEAD_CREATED: 'Lead angelegt',
  LEAD_STAGE_CHANGED: 'Lead-Phase geändert',
  LEAD_WON: 'Lead gewonnen',
  LEAD_LOST: 'Lead verloren',
  PROJECT_CREATED: 'Projekt angelegt',
  MEETING_ENDED: 'Meeting beendet',
  TASK_COMPLETED: 'Aufgabe erledigt',
  NOTE_CREATED: 'Notiz angelegt',
}

const WIRE_TO_EVENT = new Map(
  Object.entries(EVENT_WIRE).map(([event, wire]) => [wire, event as AutomationEvent]),
)

/** The wire name back to the enum. Unknown names are rejected, not guessed. */
export function eventFromWire(wire: string): AutomationEvent | null {
  return WIRE_TO_EVENT.get(wire) ?? null
}

/**
 * The envelope every webhook receives.
 *
 * Flat and stable on purpose: an n8n workflow addresses these fields in
 * expressions like `{{ $json.data.id }}`, and those expressions are typed by
 * hand into a graph soloops cannot refactor.
 */
export type AutomationPayload = {
  /** The wire name, e.g. "lead.won". */
  event: string
  /** When soloops decided to send it, ISO 8601. */
  at: string
  /** The project this concerns, when there is one. Drives scoped triggers. */
  projectId: string | null
  /** A deep link back into soloops, so a Slack message can point somewhere. */
  url: string | null
  /** The subject of the event. Shape depends on the event. */
  data: Record<string, unknown>
}

export type EmitInput = {
  event: AutomationEvent
  projectId?: string | null
  /** The path inside soloops, e.g. "/leads/abc". Made absolute on send. */
  path?: string | null
  data: Record<string, unknown>
}

/** Build the envelope. `now` and `appUrl` are arguments so this stays pure. */
export function buildPayload(
  input: EmitInput,
  options: { now: Date; appUrl: string },
): AutomationPayload {
  return {
    event: EVENT_WIRE[input.event],
    at: options.now.toISOString(),
    projectId: input.projectId ?? null,
    url: input.path ? absolute(options.appUrl, input.path) : null,
    data: input.data,
  }
}

/** Joins without doubling or dropping the slash between the two halves. */
function absolute(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export type TriggerLike = {
  id: string
  event: AutomationEvent
  projectId: string | null
  enabled: boolean
}

/**
 * Which triggers an event reaches.
 *
 * A trigger without a project is global and takes everything of its kind. A
 * trigger scoped to a project takes only events from that project — and
 * deliberately not events with no project at all: "only for ACME" should not
 * quietly include the ones that belong to nobody.
 */
export function matchTriggers<T extends TriggerLike>(
  triggers: T[],
  event: AutomationEvent,
  projectId: string | null,
): T[] {
  return triggers.filter((trigger) => {
    if (!trigger.enabled) return false
    if (trigger.event !== event) return false
    if (trigger.projectId === null) return true
    return trigger.projectId === projectId
  })
}
