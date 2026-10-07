import { prisma } from '../db.js'
import { env } from '../env.js'
import { open, seal } from './secretbox.js'
import { runStatus } from './automationMath.js'

// The status mapping is pure and lives with the rest of the testable logic.
export { runStatus }

/**
 * A client for n8n's public REST API.
 *
 * Two things about it shape this file. First, the API key cannot be handed to
 * n8n from the outside — it is created inside the editor, under Settings ->
 * n8n API. So soloops cannot be configured into a working state up front; it
 * has to accept the key afterwards and store it (see `setApiKey`). Second,
 * the editor works perfectly well without a key. Everything here is therefore
 * optional: no key means a usable builder and an empty monitoring, not a
 * broken page.
 */

/** Where the key lives when it was pasted in the interface rather than set in .env. */
const API_KEY_SETTING = 'n8n.apiKeyEnc'

export type N8nWorkflow = {
  id: string
  name: string
  active: boolean
  tags?: { id: string; name: string }[]
  nodes?: N8nNode[]
  connections?: Record<string, unknown>
  settings?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

export type N8nNode = {
  id?: string
  name: string
  type: string
  typeVersion?: number
  position?: [number, number]
  parameters?: Record<string, unknown>
  credentials?: Record<string, unknown>
  webhookId?: string
}

export type N8nExecution = {
  id: string | number
  finished?: boolean
  mode?: string
  status?: string
  startedAt?: string
  stoppedAt?: string | null
  workflowId?: string | number
  /** Only present with `includeData`; we ask for it on failures only. */
  data?: { resultData?: { error?: { message?: string } } }
}

/** A key from the interface wins over the one in .env — it is the newer fact. */
export async function getApiKey(): Promise<string | null> {
  const stored = await prisma.appSetting.findUnique({ where: { key: API_KEY_SETTING } })
  if (typeof stored?.value === 'string') {
    try {
      return open(stored.value)
    } catch {
      // A key sealed under a different JWT_SECRET cannot be recovered. Falling
      // through to .env beats failing every call from here on.
    }
  }
  return env.N8N_API_KEY ?? null
}

export async function setApiKey(key: string | null): Promise<void> {
  if (!key) {
    await prisma.appSetting.deleteMany({ where: { key: API_KEY_SETTING } })
    return
  }
  const value = seal(key)
  await prisma.appSetting.upsert({
    where: { key: API_KEY_SETTING },
    create: { key: API_KEY_SETTING, value },
    update: { value },
  })
}

export class N8nError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Thrown when there is no API key at all — the one case worth telling apart. */
export class N8nNotConfiguredError extends N8nError {
  constructor() {
    super(503, 'Kein n8n-API-Key hinterlegt')
  }
}

async function call<T>(
  method: string,
  path: string,
  options: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const key = await getApiKey()
  if (!key) throw new N8nNotConfiguredError()

  const url = new URL(`/api/v1${path}`, env.N8N_BASE_URL)
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v))
  }

  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-N8N-API-KEY': key,
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      // n8n boots slowly on a small server; a hung request should still give up.
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    // A container that is not up yet is the common case here, and it reads
    // very differently from a rejected key.
    throw new N8nError(502, `n8n nicht erreichbar (${(err as Error).message})`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new N8nError(res.status, 'n8n hat den API-Key abgelehnt')
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new N8nError(res.status, `n8n HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/** Whether n8n answers at all, and whether the key is accepted. */
export async function probe(): Promise<{
  reachable: boolean
  authorized: boolean
  error: string | null
}> {
  try {
    await call<{ data: N8nWorkflow[] }>('GET', '/workflows', { query: { limit: 1 } })
    return { reachable: true, authorized: true, error: null }
  } catch (err) {
    if (err instanceof N8nNotConfiguredError) {
      return { reachable: true, authorized: false, error: null }
    }
    if (err instanceof N8nError) {
      // 401/403 proves it is reachable — it answered, it just said no.
      const authFailure = err.status === 401 || err.status === 403
      return { reachable: authFailure, authorized: false, error: err.message }
    }
    return { reachable: false, authorized: false, error: (err as Error).message }
  }
}

/**
 * Every workflow. n8n pages with a cursor and defaults to 100 per page; for a
 * single-person instance one or two pages is the whole of it, but the loop is
 * cheap and a silently truncated list would be worse.
 */
export async function listWorkflows(): Promise<N8nWorkflow[]> {
  const all: N8nWorkflow[] = []
  let cursor: string | undefined
  do {
    const page = await call<{ data: N8nWorkflow[]; nextCursor?: string | null }>(
      'GET',
      '/workflows',
      { query: { limit: 100, cursor } },
    )
    all.push(...page.data)
    cursor = page.nextCursor ?? undefined
    // A cursor that never changes would spin forever.
  } while (cursor && all.length < 1000)
  return all
}

export async function getWorkflow(id: string): Promise<N8nWorkflow> {
  return call<N8nWorkflow>('GET', `/workflows/${encodeURIComponent(id)}`)
}

/**
 * Create a workflow. This is how a template gets in: n8n accepts the same
 * shape its own export produces, minus the fields it assigns itself.
 */
export async function createWorkflow(workflow: {
  name: string
  nodes: N8nNode[]
  connections: Record<string, unknown>
  settings?: Record<string, unknown>
}): Promise<N8nWorkflow> {
  return call<N8nWorkflow>('POST', '/workflows', {
    body: {
      name: workflow.name,
      nodes: workflow.nodes,
      connections: workflow.connections,
      // n8n rejects a create without settings on some versions.
      settings: workflow.settings ?? { executionOrder: 'v1' },
    },
  })
}

export async function setWorkflowActive(id: string, active: boolean): Promise<N8nWorkflow> {
  const verb = active ? 'activate' : 'deactivate'
  return call<N8nWorkflow>('POST', `/workflows/${encodeURIComponent(id)}/${verb}`)
}

export async function deleteWorkflow(id: string): Promise<void> {
  await call<void>('DELETE', `/workflows/${encodeURIComponent(id)}`)
}

/** Executions, newest first. Scoped to one workflow when an id is given. */
export async function listExecutions(options: {
  workflowId?: string
  limit?: number
  status?: 'error' | 'success' | 'waiting'
}): Promise<N8nExecution[]> {
  const page = await call<{ data: N8nExecution[] }>('GET', '/executions', {
    query: {
      limit: options.limit ?? 100,
      workflowId: options.workflowId,
      status: options.status,
    },
  })
  return page.data
}

/**
 * One execution including its data. Only called for failures: the payload of
 * a successful run can be megabytes and nothing here reads it.
 */
export async function getExecution(id: string | number): Promise<N8nExecution> {
  return call<N8nExecution>('GET', `/executions/${encodeURIComponent(String(id))}`, {
    query: { includeData: 'true' },
  })
}

/** Where the browser reaches the editor for a given workflow. */
export function editorUrl(n8nId?: string): string {
  const base = env.N8N_PUBLIC_PATH.endsWith('/') ? env.N8N_PUBLIC_PATH : `${env.N8N_PUBLIC_PATH}/`
  return n8nId ? `${base}workflow/${n8nId}` : `${base}home/workflows`
}
