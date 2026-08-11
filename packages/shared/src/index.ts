import { z } from 'zod'

// ---------------------------------------------------------------------------
// Gemeinsame Enums
// ---------------------------------------------------------------------------

export const ProjectStatus = z.enum(['LEAD', 'ACTIVE', 'PAUSED', 'DONE', 'ARCHIVED'])
export const EventKind = z.enum(['FOCUS', 'MEETING', 'ADMIN', 'PERSONAL', 'TRAVEL'])
export const MeetingStatus = z.enum(['PLANNED', 'RUNNING', 'DONE'])
export const InvoiceStatus = z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'])
export const RepoProvider = z.enum(['GITHUB', 'GITLAB'])
export const TimeSource = z.enum(['TIMER', 'MANUAL', 'MCP'])

const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime())

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

// ---------------------------------------------------------------------------
// Kunden
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

// ---------------------------------------------------------------------------
// Projekte
// ---------------------------------------------------------------------------

export const projectInput = z.object({
  key: z.string().min(2).max(24).regex(/^[A-Z0-9_-]+$/, 'Nur A-Z, 0-9, - und _'),
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
// Kalender
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
})

// ---------------------------------------------------------------------------
// Notizen
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
// Zeiterfassung
// ---------------------------------------------------------------------------

export const timerStartInput = z.object({
  projectId: z.string(),
  description: z.string().default(''),
  billable: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
  source: TimeSource.default('TIMER'),
})

export const timeEntryInput = z.object({
  projectId: z.string(),
  description: z.string().default(''),
  startedAt: isoDate,
  endedAt: isoDate,
  billable: z.boolean().default(true),
  rateCents: z.number().int().nonnegative().nullish(),
  tags: z.array(z.string()).default([]),
})

// ---------------------------------------------------------------------------
// Rechnungen
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
  /** true => eine Position pro Projekt, false => eine Position pro Zeiteintrag */
  groupByProject: z.boolean().default(true),
})

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export const vaultItemInput = z.object({
  title: z.string().min(1),
  username: z.string().nullish(),
  url: z.string().nullish(),
  folder: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  cipherText: z.string().min(1),
  iv: z.string().min(1),
  projectId: z.string().nullish(),
  clientId: z.string().nullish(),
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
// Typen
// ---------------------------------------------------------------------------

export type LoginInput = z.infer<typeof loginInput>
export type ClientInput = z.infer<typeof clientInput>
export type ProjectInput = z.infer<typeof projectInput>
export type EventInput = z.infer<typeof eventInput>
export type MeetingInput = z.infer<typeof meetingInput>
export type NoteInput = z.infer<typeof noteInput>
export type TimerStartInput = z.infer<typeof timerStartInput>
export type TimeEntryInput = z.infer<typeof timeEntryInput>
export type InvoiceInput = z.infer<typeof invoiceInput>
export type InvoiceFromTimeInput = z.infer<typeof invoiceFromTimeInput>
export type VaultItemInput = z.infer<typeof vaultItemInput>
export type RepoInput = z.infer<typeof repoInput>

// ---------------------------------------------------------------------------
// Helfer, die Frontend und Backend teilen
// ---------------------------------------------------------------------------

export function formatMoney(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(cents / 100)
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

/** Dezimalstunden auf 1/100 gerundet — Basis für die Rechnungsstellung. */
export function secondsToBillableHours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100
}
