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

  // --- Kalender-Sync -------------------------------------------------------
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z
    .string()
    .default('http://localhost:3000/api/calendar-accounts/google/callback'),
  CALDAV_APPLE_URL: z.string().default('https://caldav.icloud.com'),
  CALENDAR_SYNC_CRON: z.string().default('*/10 * * * *'),

  // --- Videokonferenz -----------------------------------------------------
  VIDEO_PROVIDER: z.enum(['JITSI', 'GOOGLE_MEET', 'CUSTOM']).default('JITSI'),
  JITSI_BASE_URL: z.string().default('https://meet.jit.si'),
  VIDEO_CUSTOM_URL: z.string().default(''),

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
