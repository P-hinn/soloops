/**
 * Write the API's description to docs/openapi.json.
 *
 * Builds the real server, asks it for its own schemas and exits — no port is
 * opened and no database is touched, so this runs anywhere.
 *
 *     npm run openapi
 *
 * The file is committed, so a change to a route shows up as a diff in the
 * description and not only in the code.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const target = resolve(import.meta.dirname, '../../../docs/openapi.json')

// Read by src/index.ts, which then registers its routes but neither listens
// nor goes near Postgres.
process.env.SOLOOPS_OPENAPI = '1'
const { app } = await import('../src/index.js')

await app.ready()
const spec = app.swagger() as { paths?: Record<string, unknown> }

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, JSON.stringify(spec, null, 2) + '\n')

console.log(`OpenAPI geschrieben: ${target}`)
console.log(`${Object.keys(spec.paths ?? {}).length} Pfade`)
await app.close()
process.exit(0)
