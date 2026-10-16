/**
 * The registry, without a database.
 *
 * What is worth testing here is not the storage — that is one upsert — but
 * the rules around it: every key has a schema and a label, the secrets are
 * marked, the fallbacks point at variables that exist, and a masked secret
 * never carries the secret.
 */
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

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
