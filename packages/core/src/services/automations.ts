import type { AutomationFlow } from '@prisma/client'
import { prisma } from '../db.js'
import { env } from '../env.js'
// The bundled templates are imported statically rather than read from disk:
// the production image runs the compiled tree, and a JSON file sitting next
// to a source file is exactly the thing that does not survive that.
import { templates } from '../automations/templates.js'
import {
  N8nError,
  N8nNotConfiguredError,
  createWorkflow,
  getExecution,
  listExecutions,
  listWorkflows,
  type N8nExecution,
} from './n8n.js'
import { failStreakOf, health, runStatus, type FlowHealth } from './automationMath.js'

// Pure, and therefore tested without a database — see automationMath.ts.
export { health, type FlowHealth }

/**
 * The mirror of n8n inside soloops.
 *
 * n8n stays the source of truth for the workflows themselves — the editor is
 * the editor. What is kept here is what soloops needs in order to answer
 * questions n8n cannot: which project an automation belongs to, and whether
 * anything has quietly stopped working. The alternative was to query n8n on
 * every page load, which makes the automations view as slow and as fragile as
 * the n8n container happens to be at that moment.
 */

export type SyncResult = {
  flows: number
  runs: number
  missing: number
  skipped?: string
}

/** The millisecond duration of a run, when both ends are known. */
function durationOf(execution: N8nExecution): number | null {
  if (!execution.startedAt || !execution.stoppedAt) return null
  const ms = new Date(execution.stoppedAt).getTime() - new Date(execution.startedAt).getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

/**
 * Pull workflows and their executions into the mirror.
 *
 * Without an API key this is a no-op rather than a failure: the editor works
 * on its own, and an un-keyed instance should show an empty monitoring with a
 * hint, not a red page.
 */
export async function syncAutomations(): Promise<SyncResult> {
  let workflows
  try {
    workflows = await listWorkflows()
  } catch (err) {
    if (err instanceof N8nNotConfiguredError)
      return { flows: 0, runs: 0, missing: 0, skipped: 'kein API-Key' }
    throw err
  }

  const seen = new Set<string>()
  let runCount = 0

  for (const workflow of workflows) {
    seen.add(workflow.id)
    const flow = await prisma.automationFlow.upsert({
      where: { n8nId: workflow.id },
      create: {
        n8nId: workflow.id,
        name: workflow.name,
        active: workflow.active,
        tags: (workflow.tags ?? []).map((t) => t.name),
      },
      update: {
        name: workflow.name,
        active: workflow.active,
        tags: (workflow.tags ?? []).map((t) => t.name),
        // Back from the dead: a workflow restored in n8n is no longer missing.
        missingSince: null,
      },
    })
    runCount += await syncRuns(flow)
  }

  // Workflows deleted in n8n. Their rows stay, so the run history and the
  // project assignment survive — but they are marked, and the view says so.
  const { count: missing } = await prisma.automationFlow.updateMany({
    where: { n8nId: { notIn: [...seen] }, missingSince: null },
    data: { missingSince: new Date(), active: false },
  })

  return { flows: workflows.length, runs: runCount, missing }
}

/**
 * The executions of one flow, and the roll-up the list view reads.
 *
 * Only the newest AUTOMATION_RUN_HISTORY are kept. n8n keeps the full history
 * and is one click away; duplicating it here would grow without bound for no
 * one's benefit.
 */
async function syncRuns(flow: AutomationFlow): Promise<number> {
  const executions = await listExecutions({
    workflowId: flow.n8nId,
    limit: env.AUTOMATION_RUN_HISTORY,
  })

  let written = 0
  for (const execution of executions) {
    const externalId = String(execution.id)
    const status = runStatus(execution)

    // The error message lives in the execution's data, which is a separate
    // and much larger request. Only failures are worth it, and only the
    // first time — a run that already carries its message is left alone.
    let error: string | null = null
    if (status === 'ERROR') {
      const known = await prisma.automationRun.findUnique({
        where: { flowId_externalId: { flowId: flow.id, externalId } },
        select: { error: true },
      })
      error = known?.error ?? (await firstErrorLine(execution.id))
    }

    const startedAt = execution.startedAt ? new Date(execution.startedAt) : new Date()
    const data = {
      status,
      mode: execution.mode ?? 'unknown',
      startedAt,
      finishedAt: execution.stoppedAt ? new Date(execution.stoppedAt) : null,
      durationMs: durationOf(execution),
      error,
    }
    await prisma.automationRun.upsert({
      where: { flowId_externalId: { flowId: flow.id, externalId } },
      create: { flowId: flow.id, externalId, ...data },
      update: data,
    })
    written++
  }

  await pruneRuns(flow.id)
  await rollUp(flow.id)
  return written
}

/** Everything past the newest AUTOMATION_RUN_HISTORY runs of a flow. */
async function pruneRuns(flowId: string): Promise<void> {
  const keep = await prisma.automationRun.findMany({
    where: { flowId },
    orderBy: { startedAt: 'desc' },
    take: env.AUTOMATION_RUN_HISTORY,
    select: { id: true },
  })
  await prisma.automationRun.deleteMany({
    where: { flowId, id: { notIn: keep.map((r) => r.id) } },
  })
}

/**
 * The summary the flow list reads: last outcome, totals, and how many
 * failures in a row.
 *
 * The streak is counted over the mirrored runs, newest first, and stops at
 * the first run that worked. Runs still in flight are skipped — a RUNNING
 * execution is not yet evidence either way.
 */
async function rollUp(flowId: string): Promise<void> {
  const runs = await prisma.automationRun.findMany({
    where: { flowId },
    orderBy: { startedAt: 'desc' },
    select: { status: true, startedAt: true },
  })

  await prisma.automationFlow.update({
    where: { id: flowId },
    data: {
      lastRunAt: runs[0]?.startedAt ?? null,
      lastStatus: runs[0]?.status ?? null,
      runCount: runs.length,
      errorCount: runs.filter((r) => r.status === 'ERROR').length,
      failStreak: failStreakOf(runs),
    },
  })
}

/** The failure in one line. The stack trace stays in n8n, where it is useful. */
async function firstErrorLine(executionId: string | number): Promise<string | null> {
  try {
    const full = await getExecution(executionId)
    const message = full.data?.resultData?.error?.message
    return message ? (message.split('\n')[0] ?? message).slice(0, 500) : null
  } catch {
    // Not worth failing a sync over. The run is still recorded as an error.
    return null
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export type TemplateSummary = {
  slug: string
  name: string
  description: string
  /** Which soloops event sets it off, in wire format, when it has a trigger. */
  event: string | null
  /** The node types it uses — enough for the gallery to show what it touches. */
  nodes: string[]
  /** Whether a workflow created from this template already exists. */
  installed: boolean
}

type TemplateFile = {
  slug: string
  name: string
  description: string
  workflow: {
    name: string
    nodes: { name: string; type: string; parameters?: Record<string, unknown> }[]
    connections: Record<string, unknown>
    settings?: Record<string, unknown>
  }
}

function eventOf(template: TemplateFile): string | null {
  const trigger = template.workflow.nodes.find((n) => n.type.endsWith('soloopsTrigger'))
  const event = trigger?.parameters?.event
  return typeof event === 'string' ? event : null
}

export async function listTemplates(): Promise<TemplateSummary[]> {
  const installed = new Set(
    (await prisma.automationFlow.findMany({ select: { name: true } })).map((f) => f.name),
  )
  return templates.map((template) => ({
    slug: template.slug,
    name: template.name,
    description: template.description,
    event: eventOf(template),
    nodes: [...new Set(template.workflow.nodes.map((n) => n.type))],
    installed: installed.has(template.workflow.name),
  }))
}

/**
 * Drop a template into n8n.
 *
 * It lands inactive on purpose. A template arrives with a credential
 * reference it cannot fill in — n8n credentials are created in n8n — so the
 * first thing it needs is a look from a human, not a schedule.
 */
export async function importTemplate(
  slug: string,
  options: { projectId?: string | null; name?: string } = {},
): Promise<{ flow: AutomationFlow; n8nId: string }> {
  const template = templates.find((t) => t.slug === slug)
  if (!template) throw new N8nError(404, `Unbekannte Vorlage: ${slug}`)

  const created = await createWorkflow({
    name: options.name?.trim() || template.workflow.name,
    nodes: template.workflow.nodes,
    connections: template.workflow.connections,
    settings: template.workflow.settings,
  })

  const flow = await prisma.automationFlow.upsert({
    where: { n8nId: created.id },
    create: {
      n8nId: created.id,
      name: created.name,
      active: created.active ?? false,
      projectId: options.projectId ?? null,
    },
    update: { name: created.name, projectId: options.projectId ?? null, missingSince: null },
  })

  return { flow, n8nId: created.id }
}
