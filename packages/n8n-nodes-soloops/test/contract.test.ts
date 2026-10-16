/**
 * The node's fields against the endpoints they are routed to.
 *
 * The node is declarative: every operation carries its method and URL in
 * `routing.request`, and every field carries the body or query key it fills
 * in `routing.send`. The API describes the same requests in
 * `docs/openapi.json`. Nothing held the two together, and they had drifted —
 * the lead stages here are a third copy of a list that also lives in Prisma
 * and in the connector route.
 *
 * Read straight out of the descriptions, so a renamed field fails here
 * instead of in a workflow that silently stops filling something in.
 *
 * Run `npm run openapi` after changing a route.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { INodeProperties } from 'n8n-workflow'

import { clientFields, clientOperations } from '../nodes/Soloops/ClientDescription.js'
import { leadFields, leadOperations } from '../nodes/Soloops/LeadDescription.js'
import { noteFields, noteOperations } from '../nodes/Soloops/NoteDescription.js'
import { projectFields, projectOperations } from '../nodes/Soloops/ProjectDescription.js'
import { taskFields, taskOperations } from '../nodes/Soloops/TaskDescription.js'
import { timeFields, timeOperations } from '../nodes/Soloops/TimeDescription.js'

type Op = {
  parameters?: { in: string; name: string }[]
  requestBody?: {
    content: Record<
      string,
      { schema: { properties?: Record<string, unknown>; required?: string[] } }
    >
  }
}
type Spec = { paths: Record<string, Record<string, Op>> }

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

// --- What the node says it does --------------------------------------------

type Routed = { resource: string; operation: string; method: string; url: string }

const groups: [string, INodeProperties[], INodeProperties[]][] = [
  ['client', clientOperations, clientFields],
  ['lead', leadOperations, leadFields],
  ['note', noteOperations, noteFields],
  ['project', projectOperations, projectFields],
  ['task', taskOperations, taskFields],
  ['time', timeOperations, timeFields],
]

/** `=/api/x/{{$parameter.leadId}}` is a path with one placeholder in it. */
function literal(url: string): string {
  return url.replace(/^=/, '').replace(/\{\{[^}]*\}\}/g, 'X')
}

const routed: Routed[] = []
for (const [resource, operations] of groups) {
  for (const property of operations) {
    for (const option of property.options ?? []) {
      const request = (option as { routing?: { request?: { method?: string; url?: string } } })
        .routing?.request
      if (!request?.url) continue
      routed.push({
        resource,
        operation: String((option as { value?: unknown }).value),
        method: (request.method ?? 'GET').toUpperCase(),
        url: literal(request.url),
      })
    }
  }
}

check('jede Operation traegt Methode und Pfad', routed.length, 16)

// --- Which field fills what, per operation ---------------------------------

type Field = { resource: string; operations: string[]; kind: string; property: string }

function collect(resource: string, fields: INodeProperties[]): Field[] {
  const out: Field[] = []
  const walk = (property: INodeProperties, inherited: string[]) => {
    const show = property.displayOptions?.show as Record<string, unknown[]> | undefined
    const operations = (show?.operation as string[] | undefined) ?? inherited
    const send = (property as { routing?: { send?: { type?: string; property?: string } } }).routing
      ?.send
    if (send?.property) {
      out.push({
        resource,
        operations,
        kind: send.type ?? 'body',
        property: send.property,
      })
    }
    // "Additional Fields" is a collection whose options carry their own
    // routing, and that is where most optional fields live.
    for (const option of (property.options ?? []) as INodeProperties[]) {
      if (typeof option === 'object' && 'name' in option) walk(option, operations)
    }
  }
  for (const property of fields) walk(property, [])
  return out
}

const fields = groups.flatMap(([resource, , list]) => collect(resource, list))

check('die Felder tragen ihr Ziel', fields.length > 30, true)

// --- Hold both against the specification -----------------------------------

const templates = Object.keys(spec.paths).map((path) => ({
  path,
  re: new RegExp('^' + path.replace(/\{[^}]+\}/g, '[^/]+').replace(/\/$/, '/?') + '$'),
  weight: path.split('/').filter((part) => !part.startsWith('{')).length,
}))

function match(url: string): string | null {
  const hits = templates.filter((candidate) => candidate.re.test(url))
  return hits.length ? hits.sort((a, b) => b.weight - a.weight)[0]!.path : null
}

const missingPath: string[] = []
const missingMethod: string[] = []
const unknownFields: string[] = []

for (const route of routed) {
  const key = match(route.url)
  if (!key) {
    missingPath.push(`${route.resource}.${route.operation}: ${route.method} ${route.url}`)
    continue
  }
  const op = spec.paths[key]![route.method.toLowerCase()]
  if (!op) {
    missingMethod.push(`${route.resource}.${route.operation}: ${route.method} ${key}`)
    continue
  }

  const body = op.requestBody?.content['application/json']?.schema?.properties ?? {}
  const query = new Set((op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name))

  for (const field of fields) {
    if (field.resource !== route.resource) continue
    if (field.operations.length && !field.operations.includes(route.operation)) continue
    const known = field.kind === 'query' ? query.has(field.property) : field.property in body
    if (!known) {
      unknownFields.push(
        `${route.resource}.${route.operation}: ${field.kind} ${field.property} -> ${key}`,
      )
    }
  }
}

check('jeder Pfad der Node steht in der Spezifikation', missingPath, [])
check('und mit der Methode, die die Node benutzt', missingMethod, [])
check('kein Feld schreibt in etwas, das der Endpunkt nicht kennt', [...new Set(unknownFields)], [])

// --- The enum the node offers must be the one the API accepts --------------

/** Only the `stage` field's own options — the file has several enums. */
function optionsOf(name: string): string[] {
  const found: string[] = []
  const walk = (property: INodeProperties) => {
    if (property.name === name) {
      for (const option of (property.options ?? []) as { value?: unknown }[]) {
        if (typeof option.value === 'string') found.push(option.value)
      }
    }
    for (const option of (property.options ?? []) as INodeProperties[]) {
      if (typeof option === 'object' && 'name' in option) walk(option)
    }
  }
  for (const property of leadFields) walk(property)
  return found
}

const stageOptions = optionsOf('stage')

const connectorStage =
  spec.paths['/api/automations/connector/leads/{id}/stage']?.post?.requestBody?.content[
    'application/json'
  ]?.schema
const allowed = (connectorStage as { properties?: { stage?: { enum?: string[] } } } | undefined)
  ?.properties?.stage?.enum

check('das Stage-Feld bietet ueberhaupt Stufen an', stageOptions.length > 0, true)
check(
  'die Lead-Stufen der Node sind die der API',
  stageOptions.filter((value) => !(allowed ?? []).includes(value)),
  [],
)

console.log(`\n${routed.length} Operationen und ${fields.length} Felder geprueft`)
console.log(`${pass} bestanden, ${fail} fehlgeschlagen`)
if (fail > 0) process.exit(1)
