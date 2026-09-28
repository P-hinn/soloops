import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

/**
 * Volltextsuche für Notizen, Meetings und Mails. Prisma kennt tsvector nicht,
 * darum legen wir die GIN-Indizes einmalig beim Start an.
 */
export async function ensureSearchIndexes(): Promise<void> {
  const statements = [
    `CREATE INDEX IF NOT EXISTS note_fts_idx ON "Note"
       USING GIN (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(body,'')))`,
    `CREATE INDEX IF NOT EXISTS meeting_fts_idx ON "Meeting"
       USING GIN (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(minutes,'')))`,
    `CREATE INDEX IF NOT EXISTS mail_fts_idx ON "MailMessage"
       USING GIN (to_tsvector('german', coalesce(subject,'') || ' ' || coalesce("bodyText",'')))`,
    `CREATE INDEX IF NOT EXISTS lead_fts_idx ON "Lead"
       USING GIN (to_tsvector('german', coalesce(title,'') || ' ' || coalesce(company,'') || ' ' || coalesce(notes,'')))`,
  ]
  for (const sql of statements) {
    try {
      await prisma.$executeRawUnsafe(sql)
    } catch (err) {
      console.warn('[db] Index konnte nicht angelegt werden:', (err as Error).message)
    }
  }
}

/** BigInt (UptimeRobot-IDs) ist nicht JSON-serialisierbar — global patchen. */
Object.defineProperty(BigInt.prototype, 'toJSON', {
  value: function (this: bigint) {
    return this.toString()
  },
  configurable: true,
  writable: true,
})
