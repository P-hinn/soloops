import { expandRecurrence } from '../src/services/recurrence.js'

let pass = 0, fail = 0
const fmt = (d: Date) =>
  new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).format(d)

function check(name: string, got: string[], want: string[]) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}`)
  if (!ok) { console.log('        erwartet:', want.join(' | ')); console.log('        bekommen:', got.join(' | ')) }
}

const run = (rrule: string, dtstart: string, from: string, to: string, tz: string | null = 'Europe/Berlin', exDates: Date[] = []) =>
  expandRecurrence({
    rrule, dtstart: new Date(dtstart), durationMs: 3600_000, timeZone: tz,
    exDates, windowStart: new Date(from), windowEnd: new Date(to),
  }).map((o) => fmt(o.start))

// Jährlich — der Fall "Danny Moldenhauer" (Start 2021, gesucht 2026)
check('YEARLY seit 2021 -> 2026',
  run('FREQ=YEARLY', '2021-08-25T00:00:00Z', '2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z'),
  ['25.08.2026, 02:00'])

// Monatlich — der Fall "Miete"
// Start im Winter (09:00Z = 10:00 CET). Im August muss weiterhin 10:00 LOKAL
// stehen — nicht 11:00. Genau das ist der Sinn der Zonenrechnung.
check('MONTHLY seit 2022 -> Aug 2026 (10:00 lokal bleibt 10:00)',
  run('FREQ=MONTHLY', '2022-12-25T09:00:00Z', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z'),
  ['25.08.2026, 10:00'])

// Wöchentlich mit mehreren Wochentagen
check('WEEKLY BYDAY=MO,WE',
  run('FREQ=WEEKLY;BYDAY=MO,WE', '2026-08-03T08:00:00Z', '2026-08-24T00:00:00Z', '2026-08-31T00:00:00Z'),
  ['24.08.2026, 10:00', '26.08.2026, 10:00'])

// Sommerzeit: 10:00 Berliner Zeit muss 10:00 bleiben
check('WEEKLY über die Zeitumstellung (10:00 lokal bleibt 10:00)',
  run('FREQ=WEEKLY;BYDAY=MO', '2026-10-19T08:00:00Z', '2026-10-19T00:00:00Z', '2026-11-09T00:00:00Z'),
  ['19.10.2026, 10:00', '26.10.2026, 10:00', '02.11.2026, 10:00'])

// COUNT begrenzt
check('DAILY;COUNT=3',
  run('FREQ=DAILY;COUNT=3', '2026-08-24T08:00:00Z', '2026-08-24T00:00:00Z', '2026-09-01T00:00:00Z'),
  ['24.08.2026, 10:00', '25.08.2026, 10:00', '26.08.2026, 10:00'])

// UNTIL begrenzt
check('WEEKLY;UNTIL=20260831',
  run('FREQ=WEEKLY;UNTIL=20260831T000000Z', '2026-08-03T08:00:00Z', '2026-08-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ['03.08.2026, 10:00', '10.08.2026, 10:00', '17.08.2026, 10:00', '24.08.2026, 10:00', '31.08.2026, 10:00'].slice(0, 4))

// INTERVAL
check('MONTHLY;INTERVAL=3',
  run('FREQ=MONTHLY;INTERVAL=3', '2026-02-10T08:00:00Z', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'),
  ['10.02.2026, 09:00', '10.05.2026, 09:00', '10.08.2026, 09:00', '10.11.2026, 09:00'])

// Ordinal-BYDAY: jeder letzte Freitag
check('MONTHLY;BYDAY=-1FR',
  run('FREQ=MONTHLY;BYDAY=-1FR', '2026-08-28T08:00:00Z', '2026-08-01T00:00:00Z', '2026-10-01T00:00:00Z'),
  ['28.08.2026, 10:00', '25.09.2026, 10:00'])

// Der 31. existiert nicht in jedem Monat -> Monat fällt aus (RFC 5545)
check('MONTHLY am 31. überspringt kurze Monate',
  run('FREQ=MONTHLY', '2026-01-31T08:00:00Z', '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z'),
  ['31.01.2026, 09:00', '31.03.2026, 09:00'])

// EXDATE
check('EXDATE nimmt eine Instanz raus',
  run('FREQ=DAILY;COUNT=3', '2026-08-24T08:00:00Z', '2026-08-24T00:00:00Z', '2026-09-01T00:00:00Z',
      'Europe/Berlin', [new Date('2026-08-25T08:00:00Z')]),
  ['24.08.2026, 10:00', '26.08.2026, 10:00'])

// Kaputte Regel darf nicht endlos laufen
const t0 = Date.now()
const weird = run('FREQ=BOGUS;INTERVAL=0', '2026-08-24T08:00:00Z', '2026-08-01T00:00:00Z', '2026-09-01T00:00:00Z')
check('unbekannte FREQ -> nur die Ursprungsinstanz', weird, ['24.08.2026, 10:00'])
console.log(`  (Laufzeit unbekannte Regel: ${Date.now() - t0} ms)`)

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
process.exit(fail ? 1 : 0)
