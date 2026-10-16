import { buildRuns, type Sample } from '../src/services/activity.js'

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

const TICK = 20
const IDLE_AFTER = 300
const T0 = Date.parse('2026-09-28T08:00:00.000Z')

/** One sample, `ticks` ticks after eight o'clock. */
const at = (ticks: number, bundleId: string, title = '', extra: Partial<Sample> = {}): Sample => ({
  at: new Date(T0 + ticks * TICK * 1000),
  bundleId,
  appName: bundleId.split('.').pop() ?? bundleId,
  title,
  redacted: false,
  idleSec: 0,
  ...extra,
})

const runs = (samples: Sample[]) => buildRuns(samples, TICK, IDLE_AFTER)
const shape = (samples: Sample[]) =>
  runs(samples).map((r) => ({ app: r.bundleId, sec: r.seconds, idle: r.idle }))

// ---------------------------------------------------------------------------
// Stitching
// ---------------------------------------------------------------------------

check('eine einzelne Stichprobe steht für ihren Takt', shape([at(0, 'com.apple.Terminal')]), [
  { app: 'com.apple.Terminal', sec: 20, idle: false },
])

check(
  'aufeinanderfolgende Takte derselben App werden ein Abschnitt',
  shape([
    at(0, 'com.microsoft.VSCode'),
    at(1, 'com.microsoft.VSCode'),
    at(2, 'com.microsoft.VSCode'),
  ]),
  [{ app: 'com.microsoft.VSCode', sec: 60, idle: false }],
)

check('ein App-Wechsel trennt', shape([at(0, 'com.microsoft.VSCode'), at(1, 'com.apple.Safari')]), [
  { app: 'com.microsoft.VSCode', sec: 20, idle: false },
  { app: 'com.apple.Safari', sec: 20, idle: false },
])

check(
  'ein verlorener Takt zerreißt den Abschnitt nicht',
  shape([at(0, 'com.apple.Safari'), at(2, 'com.apple.Safari')]),
  [{ app: 'com.apple.Safari', sec: 60, idle: false }],
)

check(
  'eine echte Lücke schon — es wird nicht über sie hinweggemittelt',
  shape([at(0, 'com.apple.Safari'), at(90, 'com.apple.Safari')]),
  [
    { app: 'com.apple.Safari', sec: 20, idle: false },
    { app: 'com.apple.Safari', sec: 20, idle: false },
  ],
)

// ---------------------------------------------------------------------------
// Idle time
// ---------------------------------------------------------------------------

check(
  'ab der Schwelle zählt es als Leerlauf, nicht als Arbeit an der App',
  shape([
    at(0, 'com.microsoft.VSCode'),
    at(1, 'com.microsoft.VSCode', '', { idleSec: IDLE_AFTER }),
    at(2, 'com.microsoft.VSCode', '', { idleSec: IDLE_AFTER + TICK }),
  ]),
  [
    { app: 'com.microsoft.VSCode', sec: 20, idle: false },
    { app: '', sec: 40, idle: true },
  ],
)

check(
  'knapp unter der Schwelle bleibt es Arbeit',
  shape([
    at(0, 'com.microsoft.VSCode'),
    at(1, 'com.microsoft.VSCode', '', { idleSec: IDLE_AFTER - 1 }),
  ]),
  [{ app: 'com.microsoft.VSCode', sec: 40, idle: false }],
)

check(
  'Leerlauf bleibt Leerlauf, auch wenn der Bildschirmschoner die App wechselt',
  shape([
    at(0, 'com.microsoft.VSCode', '', { idleSec: IDLE_AFTER }),
    at(1, 'com.apple.ScreenSaver', '', { idleSec: IDLE_AFTER + TICK }),
  ]),
  [{ app: '', sec: 40, idle: true }],
)

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const titled = runs([
  at(0, 'com.microsoft.VSCode', 'activity.ts'),
  at(1, 'com.microsoft.VSCode', 'TimeView.vue'),
  at(2, 'com.microsoft.VSCode', 'activity.ts'),
])

check('der Titel mit den meisten Takten gewinnt', titled[0]?.title, 'activity.ts')
check('die Zahl der verschiedenen Titel bleibt sichtbar', titled[0]?.titleCount, 2)

check(
  'ohne Titel bleibt das Feld leer, statt einen zu erfinden',
  runs([at(0, 'com.apple.Terminal')])[0]?.title,
  '',
)

check(
  'eine gesperrte App färbt den ganzen Abschnitt',
  runs([
    at(0, 'com.1password.1password', ''),
    at(1, 'com.1password.1password', '', { redacted: true }),
  ])[0]?.redacted,
  true,
)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
