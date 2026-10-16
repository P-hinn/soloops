import { changedSchedules } from '../src/services/schedules.js'

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

const planned = {
  'mail-sync': '*/10 * * * *',
  'calendar-sync': '*/15 * * * *',
  'uptime-sync': '*/5 * * * *',
}

check('ohne Änderung nichts zu tun', changedSchedules(planned, planned), [])

check(
  'ein geänderter Ausdruck wird gemeldet',
  changedSchedules(planned, { ...planned, 'mail-sync': '*/2 * * * *' }),
  ['mail-sync'],
)

check(
  'mehrere auf einmal, in stabiler Reihenfolge',
  changedSchedules(planned, {
    ...planned,
    'uptime-sync': '*/1 * * * *',
    'calendar-sync': '0 * * * *',
  }),
  ['calendar-sync', 'uptime-sync'],
)

check(
  'ein neuer Zeitplan ist eine Änderung',
  changedSchedules(planned, { ...planned, 'commit-sync': '*/30 * * * *' }),
  ['commit-sync'],
)

// A schedule that is gone is not this function's business: whether uptime
// runs at all is decided by whether there is a key, not by a comparison of
// cron expressions.
check(
  'ein entfallener Zeitplan wird nicht gemeldet',
  changedSchedules(planned, { 'mail-sync': '*/10 * * * *' }),
  [],
)

check('aus nichts wird alles neu geplant', changedSchedules({}, planned), [
  'calendar-sync',
  'mail-sync',
  'uptime-sync',
])

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
