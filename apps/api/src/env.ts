import { z } from 'zod'

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1')

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  TZ: z.string().default('Europe/Berlin'),
  APP_URL: z.string().default('http://localhost:5173'),

  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://redis:6379'),

  JWT_SECRET: z.string().min(16),
  SERVICE_TOKEN: z.string().min(8),

  OWNER_EMAIL: z.string().email().default('owner@localhost'),
  OWNER_NAME: z.string().default('Owner'),
  OWNER_PASSWORD: z.string().default('changeme'),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),

  UPTIMEROBOT_API_KEY: z.string().optional(),
  UPTIME_POLL_CRON: z.string().default('*/5 * * * *'),

  GITHUB_TOKEN: z.string().optional(),
  GITLAB_TOKEN: z.string().optional(),
  GITLAB_HOST: z.string().default('https://gitlab.com'),
  PIPELINE_POLL_CRON: z.string().default('*/3 * * * *'),

  LEXOFFICE_API_KEY: z.string().optional(),
  LEXOFFICE_BASE_URL: z.string().default('https://api.lexoffice.io'),

  // --- Automations (n8n) ---------------------------------------------------
  /// Where the API reaches n8n. Inside the compose network, not through the
  /// proxy — the API is not a browser and needs no sub-path.
  N8N_BASE_URL: z.string().default('http://n8n:5678'),
  /// Where the browser reaches the editor. Must stay same-origin, otherwise
  /// the iframe in the automations view stays empty.
  N8N_PUBLIC_PATH: z.string().default('/n8n/'),
  /// Created in n8n under Settings -> n8n API. Without it soloops can show
  /// the editor but cannot mirror flows, import templates or read runs.
  /// Can also be stored from the interface, which takes precedence.
  N8N_API_KEY: z.string().optional(),
  AUTOMATION_POLL_CRON: z.string().default('*/2 * * * *'),
  /// How many runs per flow are kept in the mirror. The full history stays in
  /// n8n; this is only what the monitoring needs.
  AUTOMATION_RUN_HISTORY: z.coerce.number().default(50),

  // --- Calendar sync -------------------------------------------------------
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z
    .string()
    .default('http://localhost:3000/api/calendar-accounts/google/callback'),
  CALDAV_APPLE_URL: z.string().default('https://caldav.icloud.com'),
  CALENDAR_SYNC_CRON: z.string().default('*/10 * * * *'),

  // --- Inbox & sales -------------------------------------------------------
  MAIL_POLL_CRON: z.string().default('*/10 * * * *'),
  /// How far back a freshly connected account is read. Not an archive import.
  MAIL_BACKFILL_DAYS: z.coerce.number().default(90),
  /// Hard floor for every fetch. Anything older is never pulled — not even if
  /// MAIL_BACKFILL_DAYS reaches further back, or the server reassigns
  /// UIDVALIDITY and a folder is read from the top again.
  MAIL_SYNC_FROM: z.coerce.date().default(new Date('2026-09-01T00:00:00Z')),
  /// Ceiling per run, so that a full mailbox cannot block the worker.
  MAIL_MAX_PER_RUN: z.coerce.number().default(200),

  // --- Video conferencing -------------------------------------------------
  VIDEO_PROVIDER: z.enum(['JITSI', 'GOOGLE_MEET', 'CUSTOM']).default('JITSI'),
  JITSI_BASE_URL: z.string().default('https://meet.jit.si'),
  VIDEO_CUSTOM_URL: z.string().default(''),

  // --- Activity (samples from the desktop app) -----------------------------
  /// The desktop app's sampling interval. The API needs it to stitch
  /// consecutive samples into segments: one sample stands for exactly that
  /// window of time.
  ACTIVITY_SAMPLE_SECONDS: z.coerce.number().default(20),
  /// Past this much idle time it no longer counts as work.
  ACTIVITY_IDLE_THRESHOLD_SEC: z.coerce.number().default(300),
  /// Raw samples are a means to an end. The worker deletes them after this.
  ACTIVITY_RETENTION_DAYS: z.coerce.number().default(30),

  DATA_DIR: z.string().default('/data'),

  INVOICE_NUMBER_PREFIX: z.string().default('RE'),
  INVOICE_DEFAULT_TAX_RATE: z.coerce.number().default(19),
  INVOICE_SMALL_BUSINESS: bool,
  INVOICE_DEFAULT_HOURLY_RATE_CENTS: z.coerce.number().default(12000),
  INVOICE_PAYMENT_TERM_DAYS: z.coerce.number().default(14),

  COMPANY_NAME: z.string().default('Solo'),
  COMPANY_STREET: z.string().default(''),
  COMPANY_ZIP: z.string().default(''),
  COMPANY_CITY: z.string().default(''),
  COMPANY_COUNTRY: z.string().default('Deutschland'),
  COMPANY_EMAIL: z.string().default(''),
  COMPANY_PHONE: z.string().default(''),
  COMPANY_VAT_ID: z.string().default(''),
  COMPANY_TAX_NUMBER: z.string().default(''),
  COMPANY_IBAN: z.string().default(''),
  COMPANY_BIC: z.string().default(''),
  COMPANY_BANK: z.string().default(''),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  console.error('Ungültige Umgebungsvariablen:\n', parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
export type Env = typeof env
