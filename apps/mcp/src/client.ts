/**
 * What every tool shares: where the API is, how to talk to it, and how a
 * result or a failure reaches Claude.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ShapeOutput, ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

export const BASE_URL = process.env.SOLOOPS_URL ?? 'http://localhost:3000'

/**
 * Reads the SERVICE_TOKEN out of the repository's .env. That way registering
 * the server needs no secret in a config file that might get committed.
 */
function serviceTokenFromRepoEnv(): string {
  try {
    const file = readFileSync(resolve(import.meta.dirname, '../../../.env'), 'utf8')
    const value = file.match(/^SERVICE_TOKEN\s*=\s*(.*)$/m)?.[1] ?? ''
    return value.trim().replace(/^["']|["']$/g, '')
  } catch {
    return ''
  }
}

/** An empty variable is not a token — fall through to the next source. */
export const TOKEN =
  process.env.SOLOOPS_TOKEN?.trim() ||
  process.env.SERVICE_TOKEN?.trim() ||
  serviceTokenFromRepoEnv()

type Query = Record<string, unknown>

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  const url = new URL(path, BASE_URL)
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value))
  }
  // A Content-Type without a body makes Fastify reject the request — so the
  // header only goes along when something is actually being sent.
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      // Tells the API who is calling — the settings page shows when Claude
      // was last here, and the desktop app uses the same token.
      'X-Soloops-Client': 'mcp',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 500)}`)
  return (text ? JSON.parse(text) : null) as T
}

export const get = <T = unknown>(path: string, query?: Query) =>
  request<T>('GET', path, undefined, query)
export const post = <T = unknown>(path: string, body: unknown = {}) =>
  request<T>('POST', path, body)
export const patch = <T = unknown>(path: string, body: unknown) => request<T>('PATCH', path, body)
export const del = <T = unknown>(path: string) => request<T>('DELETE', path)

/**
 * One tool. The handler returns plain data; the JSON shaping and the error
 * path are identical everywhere and therefore live here.
 */
export function tool<S extends ZodRawShapeCompat>(
  server: McpServer,
  name: string,
  description: string,
  shape: S,
  run: (args: ShapeOutput<S>) => Promise<unknown>,
): void {
  const handler = async (args: ShapeOutput<S>): Promise<CallToolResult> => {
    try {
      const data = await run(args)
      return {
        content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Fehler: ${(err as Error).message}` }],
        isError: true,
      }
    }
  }
  // The SDK widens the shape to its own base type when the call sits inside a
  // generic wrapper; the handler itself is typed exactly against the shape.
  server.tool(name, description, shape, handler as unknown as ToolCallback<S>)
}
