/**
 * The registry, without a database.
 *
 * What is worth testing here is not the storage — that is one upsert — but
 * the rules around it: every key has a schema and a label, the secrets are
 * marked, the fallbacks point at variables that exist, and a masked secret
 * never carries the secret.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CRON_PRESETS, cronLabel } from '@soloops/shared'
import { REGISTRY, SETTING_KEYS, isSettingKey, maskSecret } from '../src/settings.js'

let pass = 0,
  fail = 0

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
  if (!ok) {
    console.log('        erwartet:', JSON.stringify(want))
    console.log('        bekommen:', JSON.stringify(got))
  }
}

check('es gibt Einstellungen', SETTING_KEYS.length > 30, true)
check(
  'und jede hat ein Schema',
  SETTING_KEYS.filter((k) => !REGISTRY[k].schema),
  [],
)
check(
  'und ein Label',
  SETTING_KEYS.filter((k) => !REGISTRY[k].label),
  [],
)

check(
  'jeder Schlüssel ist einer Gruppe zugeordnet',
  SETTING_KEYS.filter((k) => !/^(company|invoice|keys|video|cron)\./.test(k)),
  [],
)

// --- The secrets ------------------------------------------------------------

const secrets = SETTING_KEYS.filter((k) => 'secret' in REGISTRY[k])
check('die Geheimnisse sind benannt', secrets.sort(), [
  'keys.anthropic',
  'keys.github',
  'keys.gitlab',
  'keys.lexoffice',
  'keys.uptimerobot',
])

check('ein Geheimnis zeigt nur seinen Anfang', maskSecret('sk-ant-geheim-1234'), {
  set: true,
  hint: 'sk-a…',
})
check('und nichts, wenn keines da ist', maskSecret(undefined), { set: false, hint: '' })
check('ein leerer String ist kein Geheimnis', maskSecret(''), { set: false, hint: '' })

// --- What must not be in here ----------------------------------------------
//
// secretbox.ts derives its key from JWT_SECRET, so a JWT_SECRET in the
// database would encrypt its own decryption key. The same goes for the
// values a container needs before it can read a row at all.

check(
  'nichts, was vor der Datenbank gebraucht wird',
  SETTING_KEYS.filter((k) =>
    ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL', 'SERVICE_TOKEN', 'PORT', 'DATA_DIR'].includes(
      String(REGISTRY[k].env),
    ),
  ),
  [],
)

check('unbekannte Schlüssel werden nicht akzeptiert', isSettingKey('company.strasse'), false)
check('bekannte schon', isSettingKey('company.street'), true)

// --- The schemas say what the fields mean -----------------------------------

check(
  'ein Steuersatz ist eine Zahl zwischen 0 und 100',
  [
    REGISTRY['invoice.taxRate'].schema.safeParse(19).success,
    REGISTRY['invoice.taxRate'].schema.safeParse(101).success,
    REGISTRY['invoice.taxRate'].schema.safeParse('neunzehn').success,
  ],
  [true, false, false],
)

check(
  'Kleinunternehmer ist ein Ja oder Nein',
  [
    REGISTRY['invoice.smallBusiness'].schema.safeParse(true).success,
    REGISTRY['invoice.smallBusiness'].schema.safeParse('ja').success,
  ],
  [true, false],
)

check(
  'ein Cron-Ausdruck sieht wie einer aus',
  [
    REGISTRY['cron.mail'].schema.safeParse('*/10 * * * *').success,
    REGISTRY['cron.mail'].schema.safeParse('jede Stunde').success,
  ],
  [true, false],
)

check(
  'der Videoanbieter ist einer der drei',
  [
    REGISTRY['video.provider'].schema.safeParse('JITSI').success,
    REGISTRY['video.provider'].schema.safeParse('ZOOM').success,
  ],
  [true, false],
)

// --- The intervals a person can pick ----------------------------------------
//
// A preset the API would refuse is worse than no preset: the form would offer
// it and the save would fail.

const cronSchema = REGISTRY['cron.mail'].schema
check(
  'jede angebotene Taktung ist eine, die die API annimmt',
  CRON_PRESETS.filter((preset) => !cronSchema.safeParse(preset.value).success).map((p) => p.value),
  [],
)
check(
  'und jede hat eine Beschriftung',
  CRON_PRESETS.filter((p) => !p.label.trim()).map((p) => p.value),
  [],
)
/**
 * The defaults this project ships with have to be pickable.
 *
 * Read out of env.ts rather than written down again: a default that is not a
 * preset shows up in the form as "eigener Cron-Ausdruck" for a value nobody
 * chose, which is exactly the thing this is supposed to spare people.
 */
const shippedDefaults = [
  ...readFileSync(resolve(import.meta.dirname, '../src/env.ts'), 'utf8').matchAll(
    /_CRON: z\.string\(\)\.default\('([^']+)'\)/g,
  ),
].map((m) => m[1]!)

check('es wurden Standardtaktungen gefunden', shippedDefaults.length, 6)
check(
  'jeder ausgelieferte Standard ist auswaehlbar',
  shippedDefaults.filter((pattern) => !cronLabel(pattern)),
  [],
)
check(
  'und gueltig',
  shippedDefaults.filter((pattern) => !cronSchema.safeParse(pattern).success),
  [],
)
check('eine bekannte Taktung wird benannt', cronLabel('0 * * * *'), 'jede Stunde')
check('eine eigene nicht', cronLabel('7 3 * * 2'), null)

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
