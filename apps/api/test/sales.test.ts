import { leadValueCents, stalenessDays, weightedCents } from '../src/services/leadMath.js'
import {
  constrainToKnown,
  domainToCompany,
  matchByRule,
  syncWindowStart,
} from '../src/services/mailRules.js'

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

const offer = (status: string, amountCents: number, sentOn: string | null = null) => ({
  status,
  amountCents,
  sentOn: sentOn ? new Date(sentOn) : null,
})

// ---------------------------------------------------------------------------
// Was ist ein Lead wert
// ---------------------------------------------------------------------------

check(
  'ohne Angebot zählt die eigene Schätzung',
  leadValueCents({ valueCents: 500_000, probability: 30, offers: [] }),
  500_000,
)

check(
  'ohne alles ist der Wert 0, nicht NaN',
  leadValueCents({ valueCents: null, probability: 30 }),
  0,
)

check(
  'ein verschicktes Angebot schlägt die Schätzung',
  leadValueCents({
    valueCents: 500_000,
    probability: 30,
    offers: [offer('SENT', 1_800_000, '2026-09-20')],
  }),
  1_800_000,
)

check(
  'ein Entwurf zählt nicht — der ist noch nicht raus',
  leadValueCents({ valueCents: 500_000, probability: 30, offers: [offer('DRAFT', 9_000_000)] }),
  500_000,
)

check(
  'angenommen schlägt verschickt',
  leadValueCents({
    valueCents: 500_000,
    probability: 30,
    offers: [offer('SENT', 1_800_000, '2026-09-20'), offer('ACCEPTED', 1_500_000, '2026-09-01')],
  }),
  1_500_000,
)

check(
  'bei zwei verschickten gilt das jüngste',
  leadValueCents({
    valueCents: null,
    probability: 30,
    offers: [offer('SENT', 1_000_000, '2026-08-01'), offer('SENT', 1_200_000, '2026-09-15')],
  }),
  1_200_000,
)

check(
  'ein abgelehntes Angebot fällt zurück auf die Schätzung',
  leadValueCents({ valueCents: 400_000, probability: 10, offers: [offer('REJECTED', 2_000_000)] }),
  400_000,
)

// ---------------------------------------------------------------------------
// Gewichtung
// ---------------------------------------------------------------------------

check(
  'gewichtet = Wert mal Wahrscheinlichkeit',
  weightedCents({ valueCents: 1_000_000, probability: 30 }),
  300_000,
)

check(
  'gewichtet rundet auf ganze Cent',
  weightedCents({ valueCents: 333_333, probability: 33 }),
  110_000,
)

check('0 % ergibt 0', weightedCents({ valueCents: 5_000_000, probability: 0 }), 0)

// ---------------------------------------------------------------------------
// Liegenbleiben
// ---------------------------------------------------------------------------

const now = new Date('2026-09-28T12:00:00Z')
check(
  'heute angefasst = 0 Tage',
  stalenessDays({ lastActivityAt: new Date('2026-09-28T08:00:00Z') }, now),
  0,
)
check(
  'vor zwei Wochen = 14 Tage',
  stalenessDays({ lastActivityAt: new Date('2026-09-14T12:00:00Z') }, now),
  14,
)

// ---------------------------------------------------------------------------
// Mail-Zuordnung per Regel
// ---------------------------------------------------------------------------

const ctx = {
  ownEmail: 'contact@philippniestroj.com',
  leads: [
    { id: 'lead1', title: 'DWH Beispiel', company: 'Beispiel GmbH', email: 'anna@beispiel.de' },
    { id: 'lead2', title: 'Ohne Adresse', company: null, email: null },
  ],
  clients: [
    { id: 'client1', name: 'Acme AG', company: 'Acme AG', email: 'buchhaltung@acme.de' },
    { id: 'client2', name: 'Privat Meier', company: null, email: 'meier@gmx.de' },
  ],
  projects: [{ id: 'proj1', key: 'ACME-DWH', name: 'DWH', client: 'Acme AG' }],
}

check(
  'Absenderadresse trifft den Lead',
  matchByRule({ fromEmail: 'anna@beispiel.de', toEmails: [] }, ctx)?.leadId,
  'lead1',
)

check(
  'Groß-/Kleinschreibung der Adresse ist egal',
  matchByRule({ fromEmail: 'Anna@Beispiel.DE', toEmails: [] }, ctx)?.leadId,
  'lead1',
)

check(
  'der Lead gewinnt auch, wenn er nur im Empfängerfeld steht',
  matchByRule({ fromEmail: 'fremd@anders.de', toEmails: ['anna@beispiel.de'] }, ctx)?.leadId,
  'lead1',
)

check(
  'bekannter Kunde landet beim Kunden, nicht bei einem Lead',
  matchByRule({ fromEmail: 'buchhaltung@acme.de', toEmails: [] }, ctx)?.clientId,
  'client1',
)

check(
  'gleiche Firmendomain reicht für den Kunden',
  matchByRule({ fromEmail: 'neuer.kollege@acme.de', toEmails: [] }, ctx)?.clientId,
  'client1',
)

check(
  'Domain-Treffer ist schwächer als ein Adresstreffer',
  matchByRule({ fromEmail: 'neuer.kollege@acme.de', toEmails: [] }, ctx)?.confidence,
  0.7,
)

// Der wichtigste Fall: sonst bekäme jede GMX-Adresse den Kunden mit GMX-Konto.
check(
  'Freemail-Domain darf NICHT über die Domain zugeordnet werden',
  matchByRule({ fromEmail: 'irgendwer@gmx.de', toEmails: [] }, ctx),
  null,
)

check(
  'die exakte Freemail-Adresse eines Kunden trifft trotzdem',
  matchByRule({ fromEmail: 'meier@gmx.de', toEmails: [] }, ctx)?.clientId,
  'client2',
)

check(
  'die eigene Adresse taugt nicht zur Zuordnung',
  matchByRule({ fromEmail: 'fremd@unbekannt.de', toEmails: ['contact@philippniestroj.com'] }, ctx),
  null,
)

check(
  'unbekannter Absender bleibt der AI überlassen',
  matchByRule({ fromEmail: 'wer@unbekannt.de', toEmails: [] }, ctx),
  null,
)

// ---------------------------------------------------------------------------
// AI-Vorschläge einschränken
// ---------------------------------------------------------------------------

const aiSays = (over: Record<string, unknown>) => ({
  category: 'LEAD',
  leadId: null,
  clientId: null,
  projectId: null,
  confidence: 0.8,
  reason: 'weil',
  ...over,
})

check(
  'eine erfundene Lead-Kennung wird verworfen',
  constrainToKnown(aiSays({ leadId: 'gibtsnicht' }), ctx)?.leadId,
  null,
)

check(
  'eine bekannte Kennung bleibt erhalten',
  constrainToKnown(aiSays({ leadId: 'lead1' }), ctx)?.leadId,
  'lead1',
)

check(
  'erfundene Kunden- und Projektkennungen fallen ebenfalls weg',
  constrainToKnown(aiSays({ clientId: 'x', projectId: 'y' }), ctx),
  {
    category: 'LEAD',
    leadId: null,
    clientId: null,
    projectId: null,
    confidence: 0.8,
    reason: 'weil',
  },
)

// ---------------------------------------------------------------------------
// Firmenname aus der Domain
// ---------------------------------------------------------------------------

check('Firmenname aus der Domain', domainToCompany('info@beispiel-gmbh.de'), 'Beispiel-gmbh')
check('Freemail ergibt keinen Firmennamen', domainToCompany('jemand@gmail.com'), null)
check('kaputte Adresse ergibt null', domainToCompany('keine-adresse'), null)

// ---------------------------------------------------------------------------
// Ab wann Mails geholt werden
// ---------------------------------------------------------------------------

const FLOOR = new Date('2026-09-01T00:00:00Z')

check(
  'ein älteres Konto wird auf die harte Grenze gezogen',
  syncWindowStart(new Date('2026-06-30T00:00:00Z'), FLOOR).toISOString(),
  FLOOR.toISOString(),
)

check(
  'ein später verbundenes Konto behält sein eigenes Datum',
  syncWindowStart(new Date('2026-11-15T09:00:00Z'), FLOOR).toISOString(),
  '2026-11-15T09:00:00.000Z',
)

check(
  'genau auf der Grenze bleibt die Grenze',
  syncWindowStart(FLOOR, FLOOR).toISOString(),
  FLOOR.toISOString(),
)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
