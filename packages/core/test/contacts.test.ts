import { contactInput } from '@soloops/shared'
import { withCleanEmail } from '../src/services/writeFields.js'

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

// ---------------------------------------------------------------------------
// What a person at a client may be
// ---------------------------------------------------------------------------

check('ein Name reicht', contactInput.safeParse({ name: 'Anna Berg' }).success, true)
check('ohne Namen geht nicht', contactInput.safeParse({ role: 'Buchhaltung' }).success, false)
check('ein leerer Name ist kein Name', contactInput.safeParse({ name: '' }).success, false)

check(
  'niemand ist von sich aus Hauptansprechpartner',
  contactInput.parse({ name: 'Anna Berg' }).primary,
  false,
)

check(
  'eine kaputte Adresse wird abgelehnt',
  contactInput.safeParse({ name: 'Anna Berg', email: 'anna@' }).success,
  false,
)

check(
  'ein leeres Adressfeld ist erlaubt — das Formular schickt es so',
  contactInput.safeParse({ name: 'Anna Berg', email: '' }).success,
  true,
)

// `clientId` belongs to the path, not the body of a create. A stray field
// must not be able to file somebody under a different customer.
check(
  'clientId ist kein Feld des Kontakts',
  'clientId' in contactInput.parse({ name: 'Anna Berg', clientId: 'cl_fremd' }),
  false,
)

// ---------------------------------------------------------------------------
// The empty address
//
// These two are the pair that cost data: '' has to become NULL, and a field
// that was not sent has to stay untouched.
// ---------------------------------------------------------------------------

check('leer heisst keine Adresse', withCleanEmail({ name: 'Anna', email: '' }), {
  name: 'Anna',
  email: null,
})

check('eine Adresse bleibt, wie sie ist', withCleanEmail({ email: 'anna@berg.de' }), {
  email: 'anna@berg.de',
})

check('null bleibt null', withCleanEmail({ email: null }), { email: null })

check(
  'ein Patch ohne Adressfeld loescht die Adresse nicht',
  withCleanEmail({ phone: '030 1234' } as { phone: string; email?: string | null }),
  { phone: '030 1234' },
)

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
