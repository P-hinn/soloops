/**
 * What syncs between the devices, field by field.
 *
 * An allowlist rather than "every scalar column", for two reasons. Some
 * columns are host-local bookkeeping and must not travel — `lastPushedAt`
 * belongs to this machine's CalDAV sync, `followUpNotifiedAt` to its
 * notifications, `lexofficeContactId` to its accounting link. And the phone
 * sends JSON, so the apply step needs to know which strings are really dates
 * before it hands them to Prisma.
 *
 * `Project` is in here although the brief only asked for the eight modules:
 * `TimeEntry.projectId` is non-null, so a phone that cannot see projects
 * cannot log time against one.
 */

export type FieldKind = 'string' | 'int' | 'bool' | 'date' | 'json' | 'strings' | 'dates'

export type EntitySpec = {
  /** The Prisma model name, lower-cased for `prisma[...]` access. */
  readonly model: string
  /** Fields that may be written from a remote device. */
  readonly fields: Readonly<Record<string, FieldKind>>
  /** Non-null columns. An op that creates a row has to carry all of them. */
  readonly required: readonly string[]
  /**
   * Foreign keys point at lower ranks only. Upserts are applied low rank
   * first so a parent exists before its child; deletes run in reverse.
   */
  readonly rank: number
}

export const SYNC_ENTITIES = {
  Client: {
    model: 'client',
    rank: 0,
    required: ['name'],
    fields: {
      name: 'string',
      company: 'string',
      email: 'string',
      phone: 'string',
      street: 'string',
      zip: 'string',
      city: 'string',
      country: 'string',
      vatId: 'string',
      currency: 'string',
      hourlyRateCents: 'int',
      paymentTermDays: 'int',
      notes: 'string',
      archived: 'bool',
    },
  },
  Project: {
    model: 'project',
    rank: 1,
    required: ['key', 'name'],
    fields: {
      key: 'string',
      name: 'string',
      description: 'string',
      status: 'string',
      color: 'string',
      clientId: 'string',
      hourlyRateCents: 'int',
      budgetCents: 'int',
      startsOn: 'date',
      dueOn: 'date',
    },
  },
  CalendarEvent: {
    model: 'calendarEvent',
    rank: 2,
    required: ['title', 'startsAt', 'endsAt'],
    fields: {
      title: 'string',
      description: 'string',
      location: 'string',
      startsAt: 'date',
      endsAt: 'date',
      allDay: 'bool',
      kind: 'string',
      projectId: 'string',
      clientId: 'string',
      videoUrl: 'string',
      videoProvider: 'string',
      recurring: 'bool',
      readOnly: 'bool',
      sourceUid: 'string',
      rrule: 'string',
      timeZone: 'string',
      exDates: 'dates',
      recurrenceId: 'date',
    },
  },
  Lead: {
    model: 'lead',
    rank: 2,
    required: ['title'],
    fields: {
      title: 'string',
      stage: 'string',
      source: 'string',
      contactName: 'string',
      contactEmail: 'string',
      company: 'string',
      phone: 'string',
      valueCents: 'int',
      currency: 'string',
      probability: 'int',
      expectedCloseOn: 'date',
      lostReason: 'string',
      notes: 'string',
      lastActivityAt: 'date',
      followUpOn: 'date',
      followUpNote: 'string',
      // Scored on the Mac by the worker, read-only on the phone — but it
      // travels, because the briefing in the car is most of its value.
      aiScore: 'int',
      aiScoreReason: 'string',
      aiNextStep: 'string',
      aiScoredAt: 'date',
      clientId: 'string',
      projectId: 'string',
      archived: 'bool',
    },
  },
  TimeEntry: {
    model: 'timeEntry',
    rank: 2,
    required: ['projectId', 'startedAt'],
    fields: {
      projectId: 'string',
      clientId: 'string',
      description: 'string',
      startedAt: 'date',
      endedAt: 'date',
      durationSec: 'int',
      billable: 'bool',
      rateCents: 'int',
      tags: 'strings',
      source: 'string',
    },
  },
  Meeting: {
    model: 'meeting',
    rank: 3,
    required: ['title', 'startsAt'],
    fields: {
      title: 'string',
      status: 'string',
      startsAt: 'date',
      endsAt: 'date',
      participants: 'strings',
      agenda: 'string',
      minutes: 'string',
      summary: 'string',
      decisions: 'json',
      projectId: 'string',
      clientId: 'string',
      eventId: 'string',
      videoUrl: 'string',
      videoProvider: 'string',
    },
  },
  ActionItem: {
    model: 'actionItem',
    rank: 4,
    required: ['title'],
    fields: {
      title: 'string',
      done: 'bool',
      dueOn: 'date',
      assignee: 'string',
      source: 'string',
      meetingId: 'string',
      projectId: 'string',
    },
  },
  Note: {
    model: 'note',
    rank: 4,
    required: ['title'],
    fields: {
      title: 'string',
      body: 'string',
      tags: 'strings',
      pinned: 'bool',
      projectId: 'string',
      clientId: 'string',
      meetingId: 'string',
    },
  },
} as const satisfies Record<string, EntitySpec>

export type SyncEntity = keyof typeof SYNC_ENTITIES

/**
 * What deleting a row does to other synced rows, by way of the foreign keys.
 *
 * This table exists because the database does these writes itself and Prisma
 * never sees them, so the op log would simply not have them. Delete a meeting
 * and Postgres cascades its action items away and nulls `meetingId` on its
 * notes; without the entries below, the phone would keep showing both for
 * good — and this is the kind of gap a sync is never forgiven for, because it
 * looks like the feature works until one day it quietly does not.
 *
 * Derived from the `onDelete` clauses in schema.prisma. Changing a relation
 * there means changing it here.
 */
export type SideEffect =
  /** The child row goes away with the parent (`onDelete: Cascade`). */
  | { readonly kind: 'delete'; readonly entity: SyncEntity; readonly fk: string }
  /** The child row survives with the reference cleared (`onDelete: SetNull`). */
  | { readonly kind: 'clear'; readonly entity: SyncEntity; readonly fk: string }

export const DELETE_SIDE_EFFECTS: Readonly<Record<SyncEntity, readonly SideEffect[]>> = {
  Client: [
    { kind: 'clear', entity: 'Project', fk: 'clientId' },
    { kind: 'clear', entity: 'CalendarEvent', fk: 'clientId' },
    { kind: 'clear', entity: 'Meeting', fk: 'clientId' },
    { kind: 'clear', entity: 'Note', fk: 'clientId' },
    { kind: 'clear', entity: 'Lead', fk: 'clientId' },
    { kind: 'clear', entity: 'TimeEntry', fk: 'clientId' },
  ],
  Project: [
    // TimeEntry.projectId is non-null, so the rows cannot survive it.
    { kind: 'delete', entity: 'TimeEntry', fk: 'projectId' },
    { kind: 'clear', entity: 'CalendarEvent', fk: 'projectId' },
    { kind: 'clear', entity: 'Meeting', fk: 'projectId' },
    { kind: 'clear', entity: 'Note', fk: 'projectId' },
    { kind: 'clear', entity: 'ActionItem', fk: 'projectId' },
    { kind: 'clear', entity: 'Lead', fk: 'projectId' },
  ],
  CalendarEvent: [{ kind: 'clear', entity: 'Meeting', fk: 'eventId' }],
  Meeting: [
    { kind: 'delete', entity: 'ActionItem', fk: 'meetingId' },
    { kind: 'clear', entity: 'Note', fk: 'meetingId' },
  ],
  // Offers, lead activities and mail links hang off a lead, but none of them
  // sync, so a lead delete has no effect this log has to carry.
  Lead: [],
  TimeEntry: [],
  ActionItem: [],
  Note: [],
}

export const SYNC_ENTITY_NAMES = Object.keys(SYNC_ENTITIES) as SyncEntity[]

/** Prisma model name -> entity name, for the write hook. */
export const ENTITY_BY_MODEL: Readonly<Record<string, SyncEntity>> = Object.fromEntries(
  SYNC_ENTITY_NAMES.map((name) => [SYNC_ENTITIES[name].model, name]),
)

export function isSyncEntity(name: string): name is SyncEntity {
  return Object.prototype.hasOwnProperty.call(SYNC_ENTITIES, name)
}

export function specOf(entity: SyncEntity): EntitySpec {
  return SYNC_ENTITIES[entity]
}

/** Upsert order: parents first. */
export function byRankAsc(a: SyncEntity, b: SyncEntity): number {
  return SYNC_ENTITIES[a].rank - SYNC_ENTITIES[b].rank
}
