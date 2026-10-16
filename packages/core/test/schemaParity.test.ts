/**
 * The enums in @soloops/shared against the ones in the database.
 *
 * shared cannot import @prisma/client — the browser loads that package too,
 * and nothing in the interface should pull in a database client. So the
 * values are written down twice, and this is what keeps the second copy
 * honest. Same idea as the iOS registry fixture: a copy nothing checks is a
 * copy that drifts, and this drift is the kind you only notice when a
 * workflow offers a lead stage the API has long renamed.
 */
import {
  ActivityKind,
  AutomationEvent,
  AutomationRunStatus,
  CalendarProvider,
  EventKind,
  InvoiceStatus,
  LeadSource,
  LeadStage,
  MailCategory,
  MeetingStatus,
  OfferStatus,
  ProjectStatus,
  RepoProvider,
  RunStatus,
  SyncDirection,
  TaskLinkKind,
  TaskStatus,
  TimeSource,
  VideoProvider,
} from '@soloops/shared'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

let pass = 0,
  fail = 0

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
  if (!ok) {
    console.log('        Prisma:', JSON.stringify(want))
    console.log('        shared:', JSON.stringify(got))
  }
}

/** Every `enum X { A B }` out of the schema, as a map of sorted values. */
function prismaEnums(): Record<string, string[]> {
  const schema = readFileSync(resolve(import.meta.dirname, '../prisma/schema.prisma'), 'utf8')
  const found: Record<string, string[]> = {}
  for (const match of schema.matchAll(/^enum\s+(\w+)\s*\{([^}]*)\}/gm)) {
    const [, name, body] = match
    found[name!] = body!
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => /^\w+$/.test(line))
      .sort()
  }
  return found
}

const prisma = prismaEnums()

// Not every Prisma enum needs a Zod twin — only the ones that cross the wire.
// The ones that do are listed explicitly, so adding a new enum to the schema
// is a decision and not an omission.
const mirrored: Record<string, { options: readonly string[] }> = {
  ProjectStatus,
  RepoProvider,
  EventKind,
  CalendarProvider,
  SyncDirection,
  VideoProvider,
  MeetingStatus,
  TaskStatus,
  TaskLinkKind,
  RunStatus,
  TimeSource,
  InvoiceStatus,
  LeadStage,
  LeadSource,
  OfferStatus,
  ActivityKind,
  MailCategory,
  AutomationRunStatus,
  AutomationEvent,
}

check(
  'jedes gespiegelte Enum gibt es auch in Prisma',
  Object.keys(mirrored).filter((name) => !prisma[name]),
  [],
)

for (const [name, schema] of Object.entries(mirrored)) {
  check(`${name} hat dieselben Werte`, [...schema.options].sort(), prisma[name] ?? ['?'])
}

check(
  'kein Prisma-Enum vergessen, das ueber die Leitung geht',
  Object.keys(prisma).filter((name) => !(name in mirrored)),
  // TaskStatus's closed column lives on `done`, not in the enum, and these
  // two never leave the server.
  [],
)

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
