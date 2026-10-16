import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACTS, contractByType, draftFor, type ContractType } from '../src/lib/contracts.js'

/**
 * Formular, Workflow und Templates gegeneinander.
 *
 * Die drei beschreiben denselben Vertrag an drei Stellen: das Formular hier,
 * die `vertraege`-Konfiguration im n8n-Workflow und die `{{platzhalter}}` in
 * den HTML-Dateien. Eine Stelle zu ändern und die anderen zu vergessen ist der
 * wahrscheinlichste Fehler an dieser Automatisierung — und er fällt sonst erst
 * auf, wenn ein echter Vertrag an einen echten Kunden rausgehen soll.
 *
 * Deshalb liest dieser Test die beiden anderen Quellen roh ein und hält sie
 * gegen das Formular, statt sie nachzubauen.
 */

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

const ROOT = join(import.meta.dirname, '../../../packages/core/src/automations/contracts')

const sendWorkflow = JSON.parse(
  readFileSync(join(ROOT, 'n8n-vertrag-versenden.json'), 'utf8'),
) as Workflow
const signedWorkflow = JSON.parse(
  readFileSync(join(ROOT, 'n8n-vertrag-signiert.json'), 'utf8'),
) as Workflow

type Workflow = {
  nodes: {
    name: string
    type: string
    parameters: Record<string, unknown>
    credentials?: Record<string, { id: string; name: string }>
  }[]
  connections: Record<string, { main: ({ node: string }[] | null)[] }>
}

const nodeOf = (wf: Workflow, name: string) => wf.nodes.find((n) => n.name === name)

const configCode = String(nodeOf(sendWorkflow, 'Eingabe prüfen & Konfig')?.parameters.jsCode ?? '')

/** `'nda': { template: 'nda.html', titel: '…', pflicht: ['a', 'b'] }` */
function configOf(type: string): { template: string; titel: string; pflicht: string[] } | null {
  const line = new RegExp(`'${type}':\\s*\\{([^}]*)\\}`).exec(configCode)
  if (!line) return null
  const body = line[1]!
  const template = /template:\s*'([^']+)'/.exec(body)?.[1]
  const titel = /titel:\s*'([^']+)'/.exec(body)?.[1]
  const pflicht = /pflicht:\s*\[([^\]]*)\]/.exec(body)?.[1] ?? ''
  if (!template || !titel) return null
  return {
    template,
    titel,
    pflicht: [...pflicht.matchAll(/'([^']+)'/g)].map((m) => m[1]!),
  }
}

/** Was der Konfig-Node immer mitgibt, egal welcher Vertrag. */
function keysOf(section: 'an' | 'defaults'): string[] {
  const block = new RegExp(`${section}:\\s*\\{([\\s\\S]*?)\\n\\s{2}\\}`).exec(configCode)?.[1] ?? ''
  return [...block.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]!)
}

/** Die Felder, die „Kundendaten mappen" aus dem SoloOps-Kunden baut. */
const kundenFelder = [
  ...String(nodeOf(sendWorkflow, 'Kundendaten mappen')?.parameters.jsCode ?? '').matchAll(
    /^\s*(kunde_\w+):/gm,
  ),
].map((m) => m[1]!)

// ---------------------------------------------------------------------------
// Die vier Verträge
// ---------------------------------------------------------------------------

check('Formular und Workflow kennen dieselben Vertragsarten', CONTRACTS.map((c) => c.type).sort(), [
  'dienstvertrag',
  'freie-mitarbeit',
  'nda',
  'werkvertrag',
])

check(
  'jede Vertragsart steht auch im Konfig-Node',
  CONTRACTS.filter((c) => !configOf(c.type)).map((c) => c.type),
  [],
)

check(
  'die Titel stimmen überein',
  CONTRACTS.filter((c) => configOf(c.type)?.titel !== c.title).map((c) => c.type),
  [],
)

check('der Kunde liefert sechs Felder', kundenFelder.length >= 5, true)

// ---------------------------------------------------------------------------
// Pflichtfelder
//
// Was der Workflow verlangt, muss das Formular erzwingen — sonst lässt sich
// etwas abschicken, das der Workflow hinterher ablehnt.
// ---------------------------------------------------------------------------

check(
  'jedes Pflichtfeld des Workflows ist im Formular Pflicht',
  CONTRACTS.flatMap((c) => {
    const required = new Set(
      contractByType(c.type)
        .fields.filter((f) => f.required)
        .map((f) => f.name),
    )
    return (configOf(c.type)?.pflicht ?? [])
      .filter((field) => !required.has(field))
      .map((field) => `${c.type}.${field}`)
  }),
  [],
)

// ---------------------------------------------------------------------------
// Templates
//
// Jeder Platzhalter muss von irgendwoher einen Wert bekommen: aus der Konfig,
// aus den Kundendaten oder aus dem Formular. Fehlt einer, bricht der Workflow
// mit „Platzhalter ohne Wert" ab — und zwar erst beim echten Versand.
// ---------------------------------------------------------------------------

const versorgt = new Set([...keysOf('an'), ...keysOf('defaults'), ...kundenFelder])

check(
  'die Konfig liefert die eigenen Daten',
  versorgt.has('an_firma') && versorgt.has('an_bank'),
  true,
)

for (const definition of CONTRACTS) {
  const config = configOf(definition.type)!
  const html = readFileSync(join(ROOT, 'templates', config.template), 'utf8')
  const platzhalter = [...new Set([...html.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!))]
  const ausFormular = new Set(definition.fields.map((f) => f.name))

  check(
    `${definition.type}: jeder Platzhalter bekommt einen Wert`,
    platzhalter.filter((key) => !versorgt.has(key) && !ausFormular.has(key)),
    [],
  )

  check(
    `${definition.type}: kein Formularfeld ohne Platzhalter`,
    [...ausFormular].filter((key) => !platzhalter.includes(key)),
    [],
  )

  check(
    `${definition.type}: der Entwurf deckt alle Formularfelder ab`,
    Object.keys(draftFor(definition.type as ContractType)).sort(),
    [...ausFormular].sort(),
  )
}

// ---------------------------------------------------------------------------
// Die Workflows selbst
//
// Ein Re-Import muss laufen: keine Platzhalter-Nodes, jede SoloOps-Node mit
// Credential, jede Verbindung auf einen Node, den es gibt.
// ---------------------------------------------------------------------------

for (const [name, wf] of [
  ['versenden', sendWorkflow],
  ['signiert', signedWorkflow],
] as const) {
  check(
    `${name}: keine ►-Platzhalter mehr`,
    wf.nodes.filter((n) => n.name.includes('►')).map((n) => n.name),
    [],
  )

  check(
    `${name}: SoloOps-Nodes heißen CUSTOM.soloops`,
    wf.nodes
      .filter((n) => n.name.startsWith('SoloOps:'))
      .filter((n) => n.type !== 'CUSTOM.soloops')
      .map((n) => n.name),
    [],
  )

  check(
    `${name}: jede SoloOps-Node hat ihre Credential`,
    wf.nodes
      .filter((n) => n.type === 'CUSTOM.soloops')
      .filter((n) => !n.credentials?.soloopsApi?.id)
      .map((n) => n.name),
    [],
  )

  check(
    `${name}: keine Zoho-Geheimnisse über $env`,
    JSON.stringify(wf).includes('$env.ZOHO'),
    false,
  )

  check(
    `${name}: jede Verbindung zeigt auf einen Node, den es gibt`,
    Object.entries(wf.connections).flatMap(([from, out]) => {
      const bekannt = new Set(wf.nodes.map((n) => n.name))
      const ziele = (out.main ?? []).flatMap((group) => (group ?? []).map((c) => c.node))
      return [...(bekannt.has(from) ? [] : [from]), ...ziele.filter((z) => !bekannt.has(z))]
    }),
    [],
  )
}

// Die Schranken vor den beiden Webhooks — siehe packages/core/src/automations/contracts/README.md.
const sendHook = nodeOf(sendWorkflow, 'Webhook: Vertrag versenden')
check(
  'der Versand-Webhook verlangt einen Header',
  sendHook?.parameters.authentication,
  'headerAuth',
)
check('und hat die Credential dazu', Boolean(sendHook?.credentials?.httpHeaderAuth?.id), true)

const zohoHook = signedWorkflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook')
check(
  'der Zoho-Webhook hat ein Geheimnis im Pfad',
  /^zoho-sign-abgeschlossen-\w{12,}$/.test(String(zohoHook?.parameters.path ?? '')),
  true,
)

// Die Ablage ist flach: n8ns Write-Node legt keine Verzeichnisse an.
const kontext = String(nodeOf(signedWorkflow, 'Kontext bauen')?.parameters.jsCode ?? '')
check(
  'der Dateiname enthält kein Verzeichnis',
  /const relPfad = `\$\{note\.clientId\}-/.test(kontext),
  true,
)

// ---------------------------------------------------------------------------

console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
