/**
 * Configuration that belongs to the person, not to the deployment.
 *
 * The `.env` is the right place for what a container needs before it can
 * answer a request: the database URL, the port, the secret that encrypts
 * everything else. It is the wrong place for an address on an invoice. Those
 * two had been in one file, and the consequence was concrete: `company` was
 * the only *essential* step of the onboarding checklist that could not be
 * done in the app, and it blocks the first invoice.
 *
 * So values move into `AppSetting`, and this is the registry of the ones that
 * may. Three things come with each key:
 *
 *  - **a schema**, because a value out of a database has no types. `env.ts`
 *    was the only place that ever validated configuration; without this a
 *    tax rate could be the string "neunzehn".
 *  - **whether it is a secret**, which decides whether it is encrypted at
 *    rest and whether it is ever sent back.
 *  - **the `.env` variable it falls back to**, so an existing installation
 *    keeps working and nobody has to retype what is already set.
 *
 * Reading order is database → `.env` → default. That is not new: it is what
 * services/n8n.ts has always done for its API key, and this generalises it.
 *
 * `JWT_SECRET` is deliberately not in here and cannot be: secretbox.ts
 * derives the encryption key from it, so a JWT_SECRET in the database would
 * encrypt its own decryption key.
 */
import { z } from 'zod'
import { prisma } from './db.js'
import { env } from './env.js'
import { open, seal } from './services/secretbox.js'

type Entry = {
  /** What a valid value looks like. */
  schema: z.ZodTypeAny
  /** Encrypted at rest, and never sent back in full. */
  secret?: true
  /** The environment variable this falls back to. */
  env?: keyof typeof env
  /** Shown in the interface next to the field. */
  label: string
}

const cron = z
  .string()
  .regex(/^[\d*,\-/ ]+$/, 'Sieht nicht wie ein Cron-Ausdruck aus')
  .min(9)

export const REGISTRY = {
  // --- Who is sending the invoice ------------------------------------------
  'company.name': { schema: z.string().min(1), env: 'COMPANY_NAME', label: 'Name' },
  'company.street': { schema: z.string(), env: 'COMPANY_STREET', label: 'Straße' },
  'company.zip': { schema: z.string(), env: 'COMPANY_ZIP', label: 'PLZ' },
  'company.city': { schema: z.string(), env: 'COMPANY_CITY', label: 'Ort' },
  'company.country': { schema: z.string(), env: 'COMPANY_COUNTRY', label: 'Land' },
  'company.email': {
    schema: z.string().email().or(z.literal('')),
    env: 'COMPANY_EMAIL',
    label: 'E-Mail',
  },
  'company.phone': { schema: z.string(), env: 'COMPANY_PHONE', label: 'Telefon' },
  'company.vatId': { schema: z.string(), env: 'COMPANY_VAT_ID', label: 'USt-IdNr.' },
  'company.taxNumber': { schema: z.string(), env: 'COMPANY_TAX_NUMBER', label: 'Steuernummer' },
  'company.iban': { schema: z.string(), env: 'COMPANY_IBAN', label: 'IBAN' },
  'company.bic': { schema: z.string(), env: 'COMPANY_BIC', label: 'BIC' },
  'company.bank': { schema: z.string(), env: 'COMPANY_BANK', label: 'Bank' },

  // --- How an invoice is calculated ----------------------------------------
  'invoice.numberPrefix': {
    schema: z.string().min(1).max(16),
    env: 'INVOICE_NUMBER_PREFIX',
    label: 'Nummernkreis-Präfix',
  },
  'invoice.taxRate': {
    schema: z.number().min(0).max(100),
    env: 'INVOICE_DEFAULT_TAX_RATE',
    label: 'Steuersatz (%)',
  },
  'invoice.smallBusiness': {
    schema: z.boolean(),
    env: 'INVOICE_SMALL_BUSINESS',
    label: 'Kleinunternehmer (§19 UStG)',
  },
  'invoice.hourlyRateCents': {
    schema: z.number().int().min(0),
    env: 'INVOICE_DEFAULT_HOURLY_RATE_CENTS',
    label: 'Stundensatz (Cent)',
  },
  'invoice.paymentTermDays': {
    schema: z.number().int().min(0).max(365),
    env: 'INVOICE_PAYMENT_TERM_DAYS',
    label: 'Zahlungsziel (Tage)',
  },

  // --- Keys for the optional services --------------------------------------
  'keys.anthropic': {
    schema: z.string().min(10),
    secret: true,
    env: 'ANTHROPIC_API_KEY',
    label: 'Anthropic',
  },
  'keys.anthropicModel': {
    schema: z.string().min(3),
    env: 'ANTHROPIC_MODEL',
    label: 'Anthropic-Modell',
  },
  'keys.uptimerobot': {
    schema: z.string().min(10),
    secret: true,
    env: 'UPTIMEROBOT_API_KEY',
    label: 'UptimeRobot',
  },
  'keys.github': { schema: z.string().min(10), secret: true, env: 'GITHUB_TOKEN', label: 'GitHub' },
  'keys.gitlab': { schema: z.string().min(10), secret: true, env: 'GITLAB_TOKEN', label: 'GitLab' },
  'keys.gitlabHost': { schema: z.string().url(), env: 'GITLAB_HOST', label: 'GitLab-Host' },
  'keys.lexoffice': {
    schema: z.string().min(10),
    secret: true,
    env: 'LEXOFFICE_API_KEY',
    label: 'lexoffice',
  },

  // --- Video ----------------------------------------------------------------
  'video.provider': {
    schema: z.enum(['JITSI', 'GOOGLE_MEET', 'CUSTOM']),
    env: 'VIDEO_PROVIDER',
    label: 'Videoanbieter',
  },
  'video.jitsiBaseUrl': { schema: z.string().url(), env: 'JITSI_BASE_URL', label: 'Jitsi-Adresse' },
  'video.customUrl': {
    schema: z.string().url().or(z.literal('')),
    env: 'VIDEO_CUSTOM_URL',
    label: 'Eigener Raum',
  },

  // --- How often the worker looks -------------------------------------------
  'cron.mail': { schema: cron, env: 'MAIL_POLL_CRON', label: 'Postfach' },
  'cron.calendar': { schema: cron, env: 'CALENDAR_SYNC_CRON', label: 'Kalender' },
  'cron.commits': { schema: cron, env: 'COMMIT_POLL_CRON', label: 'Commits' },
  'cron.pipelines': { schema: cron, env: 'PIPELINE_POLL_CRON', label: 'Pipelines' },
  'cron.uptime': { schema: cron, env: 'UPTIME_POLL_CRON', label: 'Uptime' },
  'cron.automations': { schema: cron, env: 'AUTOMATION_POLL_CRON', label: 'Automationen' },
} as const satisfies Record<string, Entry>

export type SettingKey = keyof typeof REGISTRY
export const SETTING_KEYS = Object.keys(REGISTRY) as SettingKey[]

export function isSettingKey(key: string): key is SettingKey {
  return key in REGISTRY
}

/** Database row keys are prefixed, so they cannot collide with the flags. */
const row = (key: SettingKey) => `setting.${key}`

// --- Reading ------------------------------------------------------------------

/**
 * A short cache, because this is read on nearly every request.
 *
 * The API and the worker are two processes, so an in-memory cache cannot see
 * the other one's writes. Thirty seconds is the compromise: a changed cron
 * takes effect within half a minute, and nobody needs an invalidation
 * channel for configuration. A write through `setSetting` drops it at once in
 * the process that did the writing.
 */
const TTL_MS = 30_000
let cache: { at: number; values: Map<string, unknown> } | null = null

export function forgetSettings(): void {
  cache = null
}

async function load(): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: 'setting.' } },
  })
  const values = new Map<string, unknown>()
  for (const entry of rows) values.set(entry.key, entry.value)
  cache = { at: Date.now(), values }
  return values
}

/** What the `.env` says for this key, already the right type. */
export function fallback<K extends SettingKey>(key: K): unknown {
  const spec = REGISTRY[key] as Entry
  if (!spec.env) return undefined
  return env[spec.env]
}

/**
 * The value in force: database, else `.env`, else undefined.
 *
 * A stored value that does not match its schema is ignored rather than
 * thrown — a bad row must not take down every request that reads it, and the
 * `.env` is a better answer than an error page.
 */
export async function getSetting<K extends SettingKey>(key: K): Promise<unknown> {
  const spec = REGISTRY[key] as Entry
  const stored = (await load()).get(row(key))
  if (stored !== undefined && stored !== null) {
    const raw = spec.secret && typeof stored === 'string' ? openOrNull(stored) : stored
    if (raw !== null) {
      const parsed = spec.schema.safeParse(raw)
      if (parsed.success) return parsed.data
      console.warn(`[settings] ${key} in der Datenbank passt nicht zum Schema — .env gilt`)
    }
  }
  return fallback(key)
}

/** Every key at once — one query for a page that shows them all. */
export async function getSettings(): Promise<Record<SettingKey, unknown>> {
  await load()
  const out = {} as Record<SettingKey, unknown>
  for (const key of SETTING_KEYS) out[key] = await getSetting(key)
  return out
}

function openOrNull(sealed: string): string | null {
  try {
    return open(sealed)
  } catch {
    // Sealed under a different JWT_SECRET. Unrecoverable, and falling through
    // to the .env beats failing every call from here on — the same decision
    // services/n8n.ts makes.
    return null
  }
}

// --- Writing ------------------------------------------------------------------

/**
 * Store one value, or clear it back to the `.env`.
 *
 * `null` deletes the row, which is how a value is handed back to the
 * configuration rather than set to empty.
 */
export async function setSetting<K extends SettingKey>(key: K, value: unknown): Promise<void> {
  const spec = REGISTRY[key] as Entry
  if (value === null || value === '') {
    await prisma.appSetting.deleteMany({ where: { key: row(key) } })
    forgetSettings()
    return
  }

  const parsed = spec.schema.parse(value)
  const stored = spec.secret ? seal(String(parsed)) : (parsed as object)
  await prisma.appSetting.upsert({
    where: { key: row(key) },
    create: { key: row(key), value: stored as never },
    update: { value: stored as never },
  })
  forgetSettings()
}

// --- What the interface may see ------------------------------------------------

/** A secret, as it is shown: set or not, and its first characters. */
export function maskSecret(value: unknown): { set: boolean; hint: string } {
  if (typeof value !== 'string' || value.length === 0) return { set: false, hint: '' }
  return { set: true, hint: value.slice(0, 4) + '…' }
}

/**
 * Every setting, ready to render: value, label, where it comes from, and
 * secrets masked.
 *
 * "Where it comes from" is the part worth sending: a field whose value is
 * still the `.env` behaves differently from one that has been overridden —
 * editing the file stops working once the database has an answer, and the
 * interface has to be able to say so.
 */
export async function describeSettings() {
  const stored = await load()
  const out: Record<
    string,
    { value: unknown; label: string; source: 'db' | 'env'; secret: boolean }
  > = {}
  for (const key of SETTING_KEYS) {
    const spec = REGISTRY[key] as Entry
    const value = await getSetting(key)
    out[key] = {
      value: spec.secret ? maskSecret(value) : value,
      label: spec.label,
      source: stored.has(row(key)) ? 'db' : 'env',
      secret: !!spec.secret,
    }
  }
  return out
}

// --- Bundles, for the places that need several at once -------------------------

/**
 * The sender of an invoice.
 *
 * One call instead of twelve: the PDF renderer wants all of it, and twelve
 * awaits against the same cached map would only be noise.
 */
export async function companyDetails() {
  const all = await getSettings()
  const text = (key: SettingKey) => (all[key] as string | undefined) ?? ''
  return {
    name: text('company.name'),
    street: text('company.street'),
    zip: text('company.zip'),
    city: text('company.city'),
    country: text('company.country'),
    email: text('company.email'),
    phone: text('company.phone'),
    vatId: text('company.vatId'),
    taxNumber: text('company.taxNumber'),
    iban: text('company.iban'),
    bic: text('company.bic'),
    bank: text('company.bank'),
  }
}

/** What an invoice falls back to when neither client nor project says. */
export async function invoiceDefaults() {
  const all = await getSettings()
  return {
    numberPrefix: (all['invoice.numberPrefix'] as string | undefined) ?? env.INVOICE_NUMBER_PREFIX,
    taxRate: (all['invoice.taxRate'] as number | undefined) ?? env.INVOICE_DEFAULT_TAX_RATE,
    smallBusiness:
      (all['invoice.smallBusiness'] as boolean | undefined) ?? env.INVOICE_SMALL_BUSINESS,
    hourlyRateCents:
      (all['invoice.hourlyRateCents'] as number | undefined) ??
      env.INVOICE_DEFAULT_HOURLY_RATE_CENTS,
    paymentTermDays:
      (all['invoice.paymentTermDays'] as number | undefined) ?? env.INVOICE_PAYMENT_TERM_DAYS,
  }
}

/** The keys for the optional services, decrypted, for the code that calls out. */
export async function serviceKeys() {
  const all = await getSettings()
  const text = (key: SettingKey) => (all[key] as string | undefined) || undefined
  return {
    anthropic: text('keys.anthropic'),
    anthropicModel: text('keys.anthropicModel'),
    uptimerobot: text('keys.uptimerobot'),
    github: text('keys.github'),
    gitlab: text('keys.gitlab'),
    gitlabHost: text('keys.gitlabHost'),
    lexoffice: text('keys.lexoffice'),
  }
}

/** The cron expressions, for the worker's schedule. */
export async function cronSettings() {
  const all = await getSettings()
  const text = (key: SettingKey, fallbackValue: string) =>
    (all[key] as string | undefined) || fallbackValue
  return {
    mail: text('cron.mail', env.MAIL_POLL_CRON),
    calendar: text('cron.calendar', env.CALENDAR_SYNC_CRON),
    commits: text('cron.commits', env.COMMIT_POLL_CRON),
    pipelines: text('cron.pipelines', env.PIPELINE_POLL_CRON),
    uptime: text('cron.uptime', env.UPTIME_POLL_CRON),
    automations: text('cron.automations', env.AUTOMATION_POLL_CRON),
  }
}
