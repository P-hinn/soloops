/**
 * Every MCP tool against the endpoint it calls.
 *
 * The tools describe their input in their own words, and the API describes
 * the same request in `docs/openapi.json`. Two descriptions of one thing
 * drift, and this drift is invisible until Claude sends a field the API
 * throws away or a date format it rejects.
 *
 * Nothing is hand-maintained here. Each tool is called once with values made
 * up from its own schema, `fetch` is intercepted, and what the tool would
 * have sent is held against the specification:
 *
 *  - does the path exist, with that method?
 *  - is every field it sends known to the endpoint?
 *  - is every field the endpoint requires one the tool can supply?
 *
 * Run `npm run openapi` after changing a route, or this fails against a
 * description that is one commit old — which is the point.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

type Spec = {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: {
          in: string
          name: string
          required?: boolean
          schema?: { enum?: string[] }
        }[]
        requestBody?: {
          content: Record<
            string,
            {
              schema: {
                properties?: Record<string, { enum?: string[] }>
                required?: string[]
              }
            }
          >
        }
      }
    >
  >
}

const spec: Spec = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../docs/openapi.json'), 'utf8'),
)

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

// --- A value for every shape, so a handler can be called -------------------

/** Something a schema accepts. Enough to reach the fetch, not more. */
function sample(schema: z.ZodTypeAny, key: string): unknown {
  const def = (
    schema as {
      _def: {
        typeName?: string
        innerType?: z.ZodTypeAny
        values?: unknown
        type?: z.ZodTypeAny
        schema?: z.ZodTypeAny
      }
    }
  )._def
  const kind = def.typeName
  switch (kind) {
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return sample(def.innerType!, key)
    case 'ZodEffects':
      return sample(def.schema!, key)
    case 'ZodString':
      // Dates have to look like dates, or the tool's own schema rejects them
      // before anything is sent.
      return /(^|[a-z])(on|at|from|to|date)$/i.test(key) ? '2026-10-16T10:00:00Z' : 'probe'
    case 'ZodNumber':
      return 1
    case 'ZodBoolean':
      return true
    case 'ZodArray':
      return []
    case 'ZodEnum':
      return (def.values as string[])[0]
    case 'ZodNativeEnum':
      return Object.values(def.values as Record<string, string>)[0]
    case 'ZodObject':
      return {}
    case 'ZodRecord':
      return {}
    default:
      return 'probe'
  }
}

// --- Collect what every tool would send ------------------------------------

type Sent = {
  tool: string
  method: string
  path: string
  body?: Record<string, unknown>
  query: string[]
}

const sent: Sent[] = []
const unreachable: string[] = []

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input.toString())
  sent.push({
    tool: current,
    method: (init?.method ?? 'GET').toUpperCase(),
    path: url.pathname,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
    query: [...url.searchParams.keys()],
  })
  // The tools only have to get as far as the request.
  throw new Error('__probe__')
}) as typeof fetch

let current = ''

/** Per tool, the fields whose schema is a fixed set of values. */
const choices = new Map<string, Record<string, string[]>>()

/** The enum inside, through the optional and default wrappers. */
function enumValues(schema: z.ZodTypeAny): string[] | null {
  const def = (
    schema as { _def: { typeName?: string; values?: unknown; innerType?: z.ZodTypeAny } }
  )._def
  if (def.typeName === 'ZodEnum') return def.values as string[]
  if (def.innerType) return enumValues(def.innerType)
  return null
}

process.env.SOLOOPS_TOKEN = 'probe-token'
const { registerAll } = await import('./harness.js')
const tools = await registerAll()

for (const [name, tool] of tools) {
  current = name
  const args: Record<string, unknown> = {}
  const offered: Record<string, string[]> = {}
  for (const [key, schema] of Object.entries(tool.shape)) {
    const values = enumValues(schema as z.ZodTypeAny)
    if (values) offered[key] = values
    const def = (schema as { _def: { typeName?: string } })._def
    // Optional fields are left out — a tool must work without them, and
    // sending everything would hide a required field the API misses.
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault') continue
    args[key] = sample(schema as z.ZodTypeAny, key)
  }
  choices.set(name, offered)
  try {
    await tool.run(args)
  } catch (err) {
    if (!String(err).includes('__probe__')) unreachable.push(`${name}: ${String(err).slice(0, 80)}`)
  }
}

globalThis.fetch = realFetch

check('jedes Tool erreicht seinen Endpunkt', unreachable, [])
check('und ruft genau einen Pfad', tools.length <= sent.length, true)

// --- Hold each call against the specification ------------------------------

/**
 * The spec path a concrete URL belongs to.
 *
 * Matched against every template rather than by guessing placeholder names:
 * the spec calls them `{id}`, `{slug}`, `{linkId}` and `{offerId}`, and a
 * test that has to know which is which is a test that breaks on the next
 * route.
 */
const templates = Object.keys(spec.paths).map((path) => ({
  path,
  re: new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+').replace(/\/$/, '/?') + '$'),
  // A literal segment is worth more than a placeholder, so `/x/{id}` never
  // wins over `/x/report`.
  weight: path.split('/').filter((part) => !part.startsWith('{')).length,
}))

function template(path: string): string | null {
  const hits = templates.filter((candidate) => candidate.re.test(path))
  if (hits.length === 0) return null
  return hits.sort((a, b) => b.weight - a.weight)[0]!.path
}

const missingPath: string[] = []
const missingMethod: string[] = []
const unknownFields: string[] = []
const missingRequired: string[] = []

for (const call of sent) {
  const key = template(call.path)
  if (!key) {
    missingPath.push(`${call.tool}: ${call.method} ${call.path}`)
    continue
  }
  const op = spec.paths[key]![call.method.toLowerCase()]
  if (!op) {
    missingMethod.push(`${call.tool}: ${call.method} ${key}`)
    continue
  }

  const schema = op.requestBody?.content['application/json']?.schema
  if (call.body && schema?.properties) {
    for (const field of Object.keys(call.body)) {
      if (!(field in schema.properties)) unknownFields.push(`${call.tool}: ${field} -> ${key}`)
    }
    for (const field of schema.required ?? []) {
      if (!(field in call.body)) missingRequired.push(`${call.tool}: ${field} fehlt fuer ${key}`)
    }
  }

  const known = new Set((op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name))
  for (const field of call.query) {
    if (!known.has(field)) unknownFields.push(`${call.tool}: ?${field} -> ${key}`)
  }
}

/**
 * Auswahllisten gegeneinander.
 *
 * Ein Tool, das `status` anbietet, schreibt die erlaubten Werte noch einmal
 * auf — das MCP-Paket hat keine gemeinsame Quelle dafür. Ein in der API
 * ergaenzter Wert faellt sonst nirgends auf: der Pfad stimmt, das Feld
 * stimmt, nur waehlen kann ihn niemand.
 */
const driftedChoices: string[] = []

/**
 * Wo ein Tool bewusst weniger anbietet als die API erlaubt.
 *
 * `STAGE_CHANGE` schreibt der Stufenwechsel selbst, `OFFER` das Angebot — von
 * Hand gesetzt waere beides eine Zeile im Verlauf, der nichts entspricht.
 * Hier aufgefuehrt statt die Regel aufzuweichen: eine benannte Ausnahme
 * bleibt eine Entscheidung, eine weiche Regel faengt den naechsten Drift
 * nicht mehr.
 */
const NARROWER = new Set(['soloops_log_lead_activity.kind'])
for (const call of sent) {
  const key = template(call.path)
  if (!key) continue
  const op = spec.paths[key]?.[call.method.toLowerCase()]
  if (!op) continue
  const body = op.requestBody?.content['application/json']?.schema?.properties ?? {}
  const params = new Map(
    (op.parameters ?? []).filter((p) => p.in === 'query').map((p) => [p.name, p.schema?.enum]),
  )

  for (const [field, values] of Object.entries(choices.get(call.tool) ?? {})) {
    const expected = body[field]?.enum ?? params.get(field)
    if (!expected) continue
    const got = [...values].sort()
    const want = [...expected].sort()
    const extra = got.filter((value) => !want.includes(value))
    // Ein Wert, den die API nicht kennt, ist immer falsch. Fehlende Werte nur
    // dort, wo die Einschraenkung nicht ausdruecklich gewollt ist.
    const incomplete =
      !NARROWER.has(`${call.tool}.${field}`) && want.some((value) => !got.includes(value))
    if (extra.length || incomplete) {
      driftedChoices.push(`${call.tool}.${field}: ${got.join(',')} statt ${want.join(',')}`)
    }
  }
}

check('die Auswahllisten der Tools sind die der API', driftedChoices, [])

check('jeder aufgerufene Pfad steht in der Spezifikation', missingPath, [])
check('und mit der Methode, die das Tool benutzt', missingMethod, [])
check('kein Tool schickt ein Feld, das der Endpunkt nicht kennt', unknownFields, [])
check('und keines laesst ein Pflichtfeld weg', missingRequired, [])

console.log(`\n${sent.length} Aufrufe aus ${tools.length} Tools geprueft`)
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
