/**
 * The shapes the automations view reads, and the few bits of presentation
 * logic shared across its tabs.
 *
 * Kept out of the components because the status badge and the duration format
 * appear in three of them, and three copies drift.
 */

export type RunStatus = 'NEW' | 'RUNNING' | 'WAITING' | 'SUCCESS' | 'ERROR' | 'CANCELED' | 'UNKNOWN'

export type FlowHealth = 'ok' | 'failing' | 'idle' | 'missing'

export type AutomationRun = {
  id: string
  status: RunStatus
  startedAt: string
  durationMs: number | null
  error: string | null
  mode: string
  flow?: { id: string; name: string; n8nId: string }
}

export type AutomationTriggerSummary = {
  id: string
  event: string
  enabled: boolean
  failStreak: number
  lastError: string | null
}

export type AutomationFlow = {
  id: string
  n8nId: string
  name: string
  active: boolean
  tags: string[]
  projectId: string | null
  lastRunAt: string | null
  lastStatus: RunStatus | null
  failStreak: number
  runCount: number
  errorCount: number
  missingSince: string | null
  health: FlowHealth
  editorUrl: string
  project: { id: string; key: string; name: string; color: string } | null
  triggers: AutomationTriggerSummary[]
  runs: AutomationRun[]
}

export type AutomationTemplate = {
  slug: string
  name: string
  description: string
  event: string | null
  nodes: string[]
  installed: boolean
}

export type AutomationDelivery = {
  id: string
  event: string
  ok: boolean
  httpStatus: number | null
  error: string | null
  durationMs: number | null
  attempt: number
  at: string
  trigger?: { id: string; event: string; webhookUrl: string }
}

export type AutomationTrigger = {
  id: string
  event: string
  wire: string
  label: string
  webhookUrl: string
  enabled: boolean
  projectId: string | null
  failStreak: number
  lastError: string | null
  lastFiredAt: string | null
  disabledByFailures: boolean
  flow: { id: string; name: string; n8nId: string } | null
  project: { id: string; key: string } | null
  deliveries: AutomationDelivery[]
}

export type AutomationToken = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

export type AutomationStatus = {
  reachable: boolean
  authorized: boolean
  error: string | null
  hasApiKey: boolean
  /** Whether soloops can sign you in to n8n instead of asking you to. */
  hasLogin: boolean
  loginEmail: string | null
  editorUrl: string
  flows: number
  failing: number
  events: { event: string; wire: string; label: string }[]
}

export const RUN_LABEL: Record<RunStatus, string> = {
  NEW: 'neu',
  RUNNING: 'läuft',
  WAITING: 'wartet',
  SUCCESS: 'ok',
  ERROR: 'Fehler',
  CANCELED: 'abgebrochen',
  UNKNOWN: 'unklar',
}

/** The badge classes per outcome. Grey for "not yet decided", never green. */
export const RUN_TONE: Record<RunStatus, string> = {
  NEW: 'bg-paper-2 text-muted',
  RUNNING: 'bg-blue/10 text-blue',
  WAITING: 'bg-warn/10 text-warn',
  SUCCESS: 'bg-good/10 text-good',
  ERROR: 'bg-bad/10 text-bad',
  CANCELED: 'bg-paper-2 text-muted',
  UNKNOWN: 'bg-paper-2 text-muted',
}

/** A square per run in the sparkline strip. */
export const RUN_BLOCK: Record<RunStatus, string> = {
  NEW: 'bg-muted/40',
  RUNNING: 'bg-blue',
  WAITING: 'bg-warn',
  SUCCESS: 'bg-good',
  ERROR: 'bg-bad',
  CANCELED: 'bg-muted/40',
  UNKNOWN: 'bg-muted/40',
}

export const HEALTH_LABEL: Record<FlowHealth, string> = {
  ok: 'läuft',
  failing: 'scheitert',
  idle: 'noch nie gelaufen',
  missing: 'in n8n gelöscht',
}

export const HEALTH_TONE: Record<FlowHealth, string> = {
  ok: 'bg-good/10 text-good',
  failing: 'bg-bad/10 text-bad',
  idle: 'bg-paper-2 text-muted',
  missing: 'bg-warn/10 text-warn',
}

/** Milliseconds as something readable. Under a second stays in milliseconds. */
export function duration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')} min`
}

export function when(iso: string | null): string {
  if (!iso) return 'nie'
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
