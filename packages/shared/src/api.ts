/**
 * What the API accepts and answers, as Zod.
 *
 * One file for three readers: Fastify validates and documents with it
 * (`npm run openapi`), the MCP server's tools are held against it by a test,
 * and the n8n node's fields are checked the same way. Before this they each
 * described the same request in their own words, and the words had drifted —
 * the node still offered a lead stage the API had renamed, and the MCP server
 * accepted a date format the API rejected.
 *
 * The enums live here rather than being imported from `@prisma/client`,
 * because this package is also loaded by the browser and nothing in the
 * interface should pull in a database client. They are held against the real
 * Prisma enums by a test in packages/core instead — same idea as the iOS
 * registry fixture: a copy nothing checks is a copy that drifts.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Pieces that nearly every route needs
// ---------------------------------------------------------------------------

/** `/:id` — written out once instead of in nineteen route files. */
export const idParam = z.object({ id: z.string() })

/** `/:id/links/:linkId` */
export const linkParam = z.object({ id: z.string(), linkId: z.string() })

/**
 * A boolean in a query string.
 *
 * `z.coerce.boolean()` reads "false" as **true** — every non-empty string is
 * truthy — so a filter written `?open=false` would do the opposite of what it
 * says. This accepts only what a client actually sends.
 */
export const boolParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')

/** An ISO timestamp, with or without an offset. */
export const isoDate = z.string().datetime({ offset: true }).or(z.string().datetime())

// ---------------------------------------------------------------------------
// Enums — mirrored from prisma/schema.prisma, held there by a test
// ---------------------------------------------------------------------------

export const CalendarProvider = z.enum(['GOOGLE', 'APPLE'])
export const SyncDirection = z.enum(['PULL', 'PUSH', 'BOTH'])
export const VideoProvider = z.enum(['JITSI', 'GOOGLE_MEET', 'CUSTOM'])
export const TaskLinkKind = z.enum(['COMMIT', 'PULL_REQUEST', 'ISSUE'])
export const LeadStage = z.enum(['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST'])
export const LeadSource = z.enum(['REFERRAL', 'WEBSITE', 'OUTBOUND', 'NETWORK', 'EVENT', 'OTHER'])
export const OfferStatus = z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'])
export const ActivityKind = z.enum([
  'NOTE',
  'CALL',
  'MAIL',
  'MEETING',
  'OFFER',
  'STAGE_CHANGE',
  'FOLLOW_UP',
])
export const MailCategory = z.enum(['LEAD', 'PROJECT', 'INVOICE', 'ADMIN', 'OTHER'])
export const AutomationEvent = z.enum([
  'LEAD_CREATED',
  'LEAD_STAGE_CHANGED',
  'LEAD_WON',
  'LEAD_LOST',
  'LEAD_FOLLOW_UP_DUE',
  'PROJECT_CREATED',
  'MEETING_ENDED',
  'TASK_COMPLETED',
  'NOTE_CREATED',
])
export const AutomationRunStatus = z.enum([
  'NEW',
  'RUNNING',
  'WAITING',
  'SUCCESS',
  'ERROR',
  'CANCELED',
  'UNKNOWN',
])
export const RunStatus = z.enum(['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED', 'UNKNOWN'])

export const TaskSource = z.enum(['MANUAL', 'AI', 'MCP'])

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const clientsQuery = z.object({ includeArchived: z.coerce.boolean().default(false) })

export const contactsQuery = z.object({
  clientId: z.string().optional(),
  includeArchived: z.coerce.boolean().default(false),
  q: z.string().optional(),
})

export const projectsQuery = z.object({
  status: z.enum(['LEAD', 'ACTIVE', 'PAUSED', 'DONE', 'ARCHIVED']).optional(),
})

export const timeQuery = z.object({
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  actionItemId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  billable: z.coerce.boolean().optional(),
  unbilledOnly: z.coerce.boolean().default(false),
  take: z.coerce.number().max(500).default(200),
})

export const timeReportQuery = z.object({
  from: z.string(),
  to: z.string(),
  billableOnly: z.coerce.boolean().default(false),
})

export const tasksQuery = z.object({
  open: boolParam.default('true'),
  status: z.enum(['TODO', 'DOING', 'BLOCKED']).optional(),
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  meetingId: z.string().optional(),
  leadId: z.string().optional(),
  overdue: boolParam.optional(),
  q: z.string().optional(),
  take: z.coerce.number().max(500).default(200),
})

export const meetingsQuery = z.object({
  projectId: z.string().optional(),
  from: z.string().optional(),
  take: z.coerce.number().max(200).default(50),
})

export const notesQuery = z.object({
  projectId: z.string().optional(),
  clientId: z.string().optional(),
  tag: z.string().optional(),
  q: z.string().optional(),
  take: z.coerce.number().max(200).default(100),
})

export const invoicesQuery = z.object({
  status: z.string().optional(),
  clientId: z.string().optional(),
  year: z.coerce.number().optional(),
})

export const leadsQuery = z.object({
  stage: LeadStage.optional(),
  includeArchived: z.coerce.boolean().default(false),
  q: z.string().optional(),
  take: z.coerce.number().max(200).default(100),
})

export const mailQuery = z.object({
  category: MailCategory.optional(),
  handled: boolParam.optional(),
  leadId: z.string().optional(),
  clientId: z.string().optional(),
  projectId: z.string().optional(),
  q: z.string().optional(),
  take: z.coerce.number().max(200).default(50),
})

export const searchQuery = z.object({
  q: z.string().min(1),
  take: z.coerce.number().max(50).default(20),
})

// ---------------------------------------------------------------------------
// Bodies that are not already an *Input in index.ts
// ---------------------------------------------------------------------------

/** A mail account, as the settings form sends it. The password is write-only. */
export const mailAccountInput = z.object({
  label: z.string().min(1),
  email: z.string().email(),
  imapHost: z.string().min(1),
  imapPort: z.coerce.number().int().default(993),
  imapSecure: z.coerce.boolean().default(true),
  imapUser: z.string().min(1),
  password: z.string().min(1),
  folders: z.array(z.string()).optional(),
})

export const taskInput = z.object({
  title: z.string().min(1),
  done: z.boolean().optional(),
  status: z.enum(['TODO', 'DOING', 'BLOCKED']).optional(),
  dueOn: z.coerce.date().nullish(),
  assignee: z.string().nullish(),
  projectId: z.string().nullish(),
  clientId: z.string().nullish(),
  meetingId: z.string().nullish(),
  leadId: z.string().nullish(),
  position: z.number().int().optional(),
  source: TaskSource.default('MANUAL'),
})

export const taskOrderInput = z.object({
  column: z.enum(['TODO', 'DOING', 'BLOCKED', 'DONE']),
  ids: z.array(z.string()).max(500),
})

export const leadInput = z.object({
  title: z.string().min(1),
  stage: LeadStage.optional(),
  source: LeadSource.optional(),
  contactName: z.string().nullish(),
  contactEmail: z.string().nullish(),
  company: z.string().nullish(),
  phone: z.string().nullish(),
  valueCents: z.number().int().nullish(),
  probability: z.number().int().min(0).max(100).optional(),
  expectedCloseOn: z.coerce.date().nullish(),
  notes: z.string().nullish(),
  clientId: z.string().nullish(),
  projectId: z.string().nullish(),
})

export const invoiceStatusInput = z.object({
  status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']),
})

export const timerStopInput = z.object({ id: z.string().optional() })

export const passwordInput = z.object({ current: z.string(), next: z.string().min(10) })

// ---------------------------------------------------------------------------
// Responses
//
// Only where the interface used to describe the answer a second time in its
// own types — that is where the two drifted. `videoProvider` is the proof:
// the API has always sent it and apps/web/src/stores/auth.ts did not mention
// it, so nothing in the interface could use it.
// ---------------------------------------------------------------------------

export const configResponse = z.object({
  companyName: z.string(),
  currency: z.string(),
  smallBusiness: z.boolean(),
  defaultTaxRate: z.number(),
  defaultHourlyRateCents: z.number(),
  videoProvider: VideoProvider,
  features: z.record(z.string(), z.boolean()),
})

export const meResponse = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
})

export const loginResponse = z.object({ token: z.string(), user: meResponse })

/** The shape every refusal has. */
export const errorResponse = z.object({ error: z.string() })

export type ConfigResponse = z.infer<typeof configResponse>
export type MeResponse = z.infer<typeof meResponse>
export type MailAccountInput = z.infer<typeof mailAccountInput>
export type TaskInput = z.infer<typeof taskInput>
export type LeadInput = z.infer<typeof leadInput>
