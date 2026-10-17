/**
 * What a project reads as, and what the API takes back.
 *
 * The status labels used to sit inside the list view, which is why the detail
 * page had none. The draft/payload pair is the other half: an input holds a
 * day, a euro amount and an empty string, the API wants an instant, cents and
 * null — one place that knows the difference, so the create form and the edit
 * form cannot drift apart on it.
 */

import { ProjectStatus } from '@soloops/shared'
import { centsToEuro, euroToCents } from './money'

export const PROJECT_STATUSES = ProjectStatus.options
export type ProjectStatusValue = (typeof PROJECT_STATUSES)[number]

export const STATUS_LABEL: Record<ProjectStatusValue, string> = {
  LEAD: 'Lead',
  ACTIVE: 'aktiv',
  PAUSED: 'pausiert',
  DONE: 'fertig',
  ARCHIVED: 'archiviert',
}

/** Only what is still moving earns a colour; done and archived stay quiet. */
export const STATUS_TONE: Record<ProjectStatusValue, string> = {
  LEAD: 'badge-blue',
  ACTIVE: 'badge-good',
  PAUSED: 'badge-warn',
  DONE: '',
  ARCHIVED: '',
}

export const statusLabel = (status: string): string =>
  STATUS_LABEL[status as ProjectStatusValue] ?? status

export const statusTone = (status: string): string =>
  STATUS_TONE[status as ProjectStatusValue] ?? ''

/** A project as the form carries it — strings, because that is what inputs hold. */
export type ProjectDraft = {
  key: string
  name: string
  clientId: string
  status: ProjectStatusValue
  color: string
  description: string
  startsOn: string
  dueOn: string
  hourlyRate: string
  budget: string
}

/** As much of a project as the form reads back, from the list or the detail endpoint. */
export type ProjectFields = {
  key: string
  name: string
  status: string
  color: string
  description?: string | null
  clientId?: string | null
  client?: { id: string } | null
  hourlyRateCents?: number | null
  budgetCents?: number | null
  startsOn?: string | null
  dueOn?: string | null
}

export const DEFAULT_COLOR = '#6366f1'

/** `2026-10-16T00:00:00.000Z` as the date input wants it. */
const day = (value?: string | null): string => (value ? value.slice(0, 10) : '')

/** A date input gives a day; the API wants an instant. */
const instant = (value: string): string | null =>
  value ? new Date(`${value}T00:00:00Z`).toISOString() : null

export function emptyDraft(): ProjectDraft {
  return {
    key: '',
    name: '',
    clientId: '',
    status: 'ACTIVE',
    color: DEFAULT_COLOR,
    description: '',
    startsOn: '',
    dueOn: '',
    hourlyRate: '',
    budget: '',
  }
}

export function draftOf(project: ProjectFields): ProjectDraft {
  return {
    key: project.key,
    name: project.name,
    clientId: project.clientId ?? project.client?.id ?? '',
    status: project.status as ProjectStatusValue,
    color: project.color || DEFAULT_COLOR,
    description: project.description ?? '',
    startsOn: day(project.startsOn),
    dueOn: day(project.dueOn),
    hourlyRate: centsToEuro(project.hourlyRateCents),
    budget: centsToEuro(project.budgetCents),
  }
}

/**
 * The body for POST and PATCH alike.
 *
 * Every field is sent, including the cleared ones as null: a PATCH that leaves
 * a field out keeps the old value, which on an edit form reads as "the change
 * did not save".
 */
export function projectPayload(draft: ProjectDraft) {
  return {
    key: draft.key.trim().toUpperCase(),
    name: draft.name.trim(),
    clientId: draft.clientId || null,
    status: draft.status,
    color: draft.color,
    description: draft.description.trim() || null,
    startsOn: instant(draft.startsOn),
    dueOn: instant(draft.dueOn),
    hourlyRateCents: euroToCents(draft.hourlyRate),
    budgetCents: euroToCents(draft.budget),
  }
}
