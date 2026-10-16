import { z } from 'zod'

export * from './api.js'

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const ProjectStatus = z.enum(['LEAD', 'ACTIVE', 'PAUSED', 'DONE', 'ARCHIVED'])
export const EventKind = z.enum(['FOCUS', 'MEETING', 'ADMIN', 'PERSONAL', 'TRAVEL'])
export const MeetingStatus = z.enum(['PLANNED', 'RUNNING', 'DONE'])
export const InvoiceStatus = z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'])
export const RepoProvider = z.enum(['GITHUB', 'GITLAB'])
export const TimeSource = z.enum(['TIMER', 'MANUAL', 'MCP'])
/// Board column of an open task. Closed is `done`, not a status.
export const TaskStatus = z.enum(['TODO', 'DOING', 'BLOCKED'])

const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime())

/** Truncates overlong strings instead of rejecting the request. */
const cut = (max: number) => (value: string) => value.slice(0, max)

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export const clientInput = z.object({
  name: z.string().min(1),
  company: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  phone: z.string().nullish(),
  street: z.string().nullish(),
  zip: z.string().nullish(),
  city: z.string().nullish(),
  country: z.string().default('Deutschland'),
  vatId: z.string().nullish(),
  currency: z.string().default('EUR'),
  hourlyRateCents: z.number().int().nonnegative().nullish(),
  paymentTermDays: z.number().int().positive().default(14),
  notes: z.string().nullish(),
  archived: z.boolean().default(false),
})

/**
 * A person at a client. `clientId` is not in here: on create it comes from
 * the path, and moving a contact to another customer is its own route, so a
 * stray field in a patch body cannot quietly re-file somebody.
 */
export const contactInput = z.object({
  name: z.string().min(1),
  role: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  phone: z.string().nullish(),
  notes: z.string().nullish(),
  primary: z.boolean().default(false),
  archived: z.boolean().default(false),
})

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * The four soloops can generate and send itself.
 *
 * These strings are not free: they are the file names of the HTML templates,
 * the keys of the n8n workflow's own configuration and the values its webhook
 * validates. Renaming one here renames it in four places — the test in
 * apps/web/test/contracts.test.ts holds them together.
 */
export const SENDABLE_CONTRACT_TYPES = [
  'nda',
  'werkvertrag',
  'dienstvertrag',
  'freie-mitarbeit',
] as const

/**
 * Everything that may be filed, which is more than can be sent: a framework
 * agreement, a data processing agreement, the thing the customer's lawyer
 * wrote. Those arrive as a finished PDF and are uploaded, so they need no
 * template — only a name.
 */
export const CONTRACT_TYPES = [
  ...SENDABLE_CONTRACT_TYPES,
  'rahmenvertrag',
  'avv',
  'sonstiges',
] as const

export const ContractType = z.enum(CONTRACT_TYPES)
export const SendableContractType = z.enum(SENDABLE_CONTRACT_TYPES)

/**
 * Where a contract stands.
 *
 * `beendet` is set by hand — a contract that ran out keeps its `signiert`
 * until somebody says otherwise, and `endsOn` in the past is what the
 * interface reads to show it as expired.
 */
export const CONTRACT_STATUSES = [
  'entwurf',
  'versendet',
  'signiert',
  'abgelehnt',
  'beendet',
] as const

export const ContractStatus = z.enum(CONTRACT_STATUSES)

/** How the stored status is named where it is set by hand. */
export const CONTRACT_STATUS_LABELS: Record<(typeof CONTRACT_STATUSES)[number], string> = {
  entwurf: 'Entwurf',
  versendet: 'Versendet',
  signiert: 'Unterschrieben',
  abgelehnt: 'Abgelehnt',
  beendet: 'Beendet',
}

/** How the types are named in the interface. */
export const CONTRACT_TYPE_LABELS: Record<(typeof CONTRACT_TYPES)[number], string> = {
  nda: 'NDA',
  werkvertrag: 'Werkvertrag',
  dienstvertrag: 'Dienstvertrag',
  'freie-mitarbeit': 'Freie Mitarbeit',
  rahmenvertrag: 'Rahmenvertrag',
  avv: 'AV-Vertrag',
  sonstiges: 'Sonstiges',
}

/**
 * A contract as it is filed by hand.
 *
 * `clientId` is not in here for the same reason it is not in `contactInput`:
 * on create it comes from the body of the create route explicitly, and the
 * fields a workflow writes — `externalId`, `taskId`, `file` — are not part of
 * it at all. Those three say where a contract came from, and a PATCH from the
 * interface must not be able to claim a different origin for it.
 */
export const contractInput = z.object({
  type: ContractType,
  title: z.string().min(1).transform(cut(200)),
  status: ContractStatus.default('entwurf'),
  projectId: z.string().nullish(),
  signedOn: isoDate.nullish(),
  startsOn: isoDate.nullish(),
  endsOn: isoDate.nullish(),
  amountCents: z.number().int().nonnegative().nullish(),
  notes: z.string().nullish(),
  archived: z.boolean().default(false),
})

// ---------------------------------------------------------------------------
/**
 * How many days a contract still runs. Negative once it has run out, null
 * when it has no end — the usual case for an NDA.
 *
 * Compared by calendar day rather than by instant: a contract that ends today
 * is still valid today, and the stored date carries no useful time of day.
 * The calendar is the local one — the browser's in the interface, TZ in the
 * API — which is the one whoever asks is looking at.
 */
export function contractDaysLeft(
  endsOn: Date | string | null | undefined,
  now: Date,
): number | null {
  if (!endsOn) return null
  const end = endsOn instanceof Date ? endsOn : new Date(endsOn)
  if (Number.isNaN(end.getTime())) return null
  const day = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  return Math.round((day(end) - day(now)) / 86_400_000)
}

/** Inside this many days before the end, a contract wants attention. */
export const EXPIRY_WARNING_DAYS = 30

/** What a contract is, in one word. More than its status, see below. */
export const CONTRACT_STATES = [
  'entwurf',
  'versendet',
  'abgelehnt',
  'beendet',
  'laeuft',
  'laeuft-ab',
  'abgelaufen',
] as const

export type ContractState = (typeof CONTRACT_STATES)[number]

/**
 * Status and dates together.
 *
 * A signed contract whose end date has passed is expired, and nothing writes
 * that: there is no job walking the table at midnight, so it is derived on
 * read — by the interface and by the API, which is why it lives here.
 */
export function contractState(
  contract: { status: string; endsOn?: Date | string | null },
  now: Date,
): ContractState {
  if (contract.status !== 'signiert') {
    return (CONTRACT_STATES as readonly string[]).includes(contract.status)
      ? (contract.status as ContractState)
      : 'entwurf'
  }
  const left = contractDaysLeft(contract.endsOn, now)
  if (left === null) return 'laeuft'
  if (left < 0) return 'abgelaufen'
  return left <= EXPIRY_WARNING_DAYS ? 'laeuft-ab' : 'laeuft'
}

export const CONTRACT_STATE_LABELS: Record<ContractState, string> = {
  entwurf: 'Entwurf',
  versendet: 'Versendet',
  abgelehnt: 'Abgelehnt',
  beendet: 'Beendet',
  laeuft: 'Läuft',
  'laeuft-ab': 'Läuft ab',
  abgelaufen: 'Abgelaufen',
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export const projectInput = z.object({
  key: z
    .string()
    .min(2)
    .max(24)
    .regex(/^[A-Z0-9_-]+$/, 'Nur A-Z, 0-9, - und _'),
  name: z.string().min(1),
  description: z.string().nullish(),
  status: ProjectStatus.default('ACTIVE'),
  color: z.string().default('#6366f1'),
  clientId: z.string().nullish(),
  hourlyRateCents: z.number().int().nonnegative().nullish(),
  budgetCents: z.number().int().nonnegative().nullish(),
  startsOn: isoDate.nullish(),
  dueOn: isoDate.nullish(),
})

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const eventInput = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  location: z.string().nullish(),
  startsAt: isoDate,
  endsAt: isoDate,
  allDay: z.boolean().default(false),
  kind: EventKind.default('FOCUS'),
  projectId: z.string().nullish(),
  clientId: z.string().nullish(),
  /** true => the server creates a video room; false => remove an existing one */
  withVideo: z.boolean().optional(),
  /** A link of your own, when no room should be created */
  videoUrl: z.string().nullish(),
})

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export const meetingInput = z.object({
  title: z.string().min(1),
  status: MeetingStatus.default('PLANNED'),
  startsAt: isoDate,
  endsAt: isoDate.nullish(),
  participants: z.array(z.string()).default([]),
  agenda: z.string().nullish(),
  minutes: z.string().nullish(),
  projectId: z.string().nullish(),
  clientId: z.string().nullish(),
  createEvent: z.boolean().default(true),
  /** Create a video room (Jitsi or Google Meet, depending on the config) */
  withVideo: z.boolean().default(false),
  videoUrl: z.string().nullish(),
})

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export const noteInput = z.object({
  title: z.string().min(1),
  body: z.string().default(''),
  tags: z.array(z.string()).default([]),
  pinned: z.boolean().default(false),
  projectId: z.string().nullish(),
  clientId: z.string().nullish(),
  meetingId: z.string().nullish(),
})

// ---------------------------------------------------------------------------
// Time tracking
// ---------------------------------------------------------------------------

/**
 * Starting the clock.
 *
 * Either on a project or on a task: with `actionItemId` the project comes
 * from the task, so the two cannot name different ones. A task without a
 * project cannot carry time — `TimeEntry.projectId` is non-null, and the
 * hourly rate hangs off the project.
 */
export const timerStartInput = z
  .object({
    projectId: z.string().optional(),
    actionItemId: z.string().optional(),
    description: z.string().default(''),
    billable: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
    source: TimeSource.default('TIMER'),
  })
  .refine((v) => v.projectId || v.actionItemId, {
    message: 'Projekt oder Aufgabe wird gebraucht',
  })

export const timeEntryInput = z.object({
  projectId: z.string(),
  actionItemId: z.string().nullish(),
  description: z.string().default(''),
  startedAt: isoDate,
  endedAt: isoDate,
  billable: z.boolean().default(true),
  rateCents: z.number().int().nonnegative().nullish(),
  tags: z.array(z.string()).default([]),
})

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

/**
 * One sample from the desktop app. The instant arrives as milliseconds since
 * the epoch rather than an ISO string: the app builds its JSON by hand and
 * would otherwise have to reimplement a calendar nobody needs.
 */
export const activitySampleInput = z.object({
  atMs: z.number().int().positive(),
  bundleId: z.string().default('').transform(cut(200)),
  appName: z.string().default('').transform(cut(200)),
  title: z.string().default('').transform(cut(300)),
  redacted: z.boolean().default(false),
  /// A day of idling is the ceiling — more than that means the machine slept.
  idleSec: z.number().int().nonnegative().max(86_400).default(0),
})

export const activitySampleBatch = z.object({
  samples: z.array(activitySampleInput).max(1000),
})

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export const invoiceItemInput = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().default('Std.'),
  unitPriceCents: z.number().int(),
})

export const invoiceInput = z.object({
  clientId: z.string(),
  projectId: z.string().nullish(),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  taxRate: z.number().min(0).max(100).optional(),
  smallBusiness: z.boolean().optional(),
  intro: z.string().nullish(),
  notes: z.string().nullish(),
  items: z.array(invoiceItemInput).default([]),
})

export const invoiceFromTimeInput = z.object({
  clientId: z.string(),
  projectId: z.string().nullish(),
  from: isoDate,
  to: isoDate,
  /** true => one line item per project, false => one per time entry */
  groupByProject: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// CI/CD
// ---------------------------------------------------------------------------

export const repoInput = z.object({
  provider: RepoProvider,
  slug: z.string().regex(/^[^/]+\/.+$/, 'Format: owner/repo'),
  branch: z.string().default('main'),
  projectId: z.string().nullish(),
  enabled: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoginInput = z.infer<typeof loginInput>
export type ClientInput = z.infer<typeof clientInput>
export type ContactInput = z.infer<typeof contactInput>
export type ContractInput = z.infer<typeof contractInput>
export type ProjectInput = z.infer<typeof projectInput>
export type EventInput = z.infer<typeof eventInput>
export type MeetingInput = z.infer<typeof meetingInput>
export type NoteInput = z.infer<typeof noteInput>
export type TimerStartInput = z.infer<typeof timerStartInput>
export type TimeEntryInput = z.infer<typeof timeEntryInput>
export type InvoiceInput = z.infer<typeof invoiceInput>
export type InvoiceFromTimeInput = z.infer<typeof invoiceFromTimeInput>
export type RepoInput = z.infer<typeof repoInput>
export type ActivitySampleInput = z.infer<typeof activitySampleInput>

// ---------------------------------------------------------------------------
// Helpers shared by frontend and backend
// ---------------------------------------------------------------------------

export function formatMoney(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(cents / 100)
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

/** Decimal hours rounded to 1/100 — the basis for invoicing. */
export function secondsToBillableHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100
}
