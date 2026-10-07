import type { AutomationEvent } from '@prisma/client'
import { prisma } from '../db.js'
import { env } from '../env.js'
import { openOrNull, seal } from './secretbox.js'
import {
  buildPayload,
  matchTriggers,
  type AutomationPayload,
  type EmitInput,
} from './automationEvents.js'
import {
  FAIL_STREAK_LIMIT,
  MAX_ATTEMPTS,
  backoffMs,
  newSecret,
  shouldRetry,
  sign,
  verifySignature,
} from './automationMath.js'

// The retry policy, the signature and the status mapping live in
// automationMath.ts (no Prisma, no env, so they stay testable) and are
// re-exported here — callers should only need to know one place.
export { FAIL_STREAK_LIMIT, MAX_ATTEMPTS, backoffMs, newSecret, shouldRetry, sign, verifySignature }

/**
 * Posting soloops events to n8n webhooks.
 *
 * The retry policy is the interesting part. An n8n container restarts, gets
 * redeployed, or a workflow is mid-save — all of which produce a minute or
 * two of refused connections, not a permanent failure. So a delivery is
 * retried a few times with widening gaps. What is *not* retried is a 4xx
 * other than 408/429: a 404 means the workflow was deleted or deactivated,
 * and hammering it changes nothing.
 */

export function sealSecret(secret: string): string {
  return seal(secret)
}

export type DeliveryJob = {
  triggerId: string
  event: AutomationEvent
  payload: AutomationPayload
  attempt: number
}

export type DeliveryOutcome = {
  ok: boolean
  httpStatus: number | null
  error: string | null
  /** Set when the caller should enqueue another attempt, in milliseconds. */
  retryInMs: number | null
}

/**
 * One attempt at one webhook, recorded either way.
 *
 * The record is the point. A webhook that stopped working is invisible
 * otherwise — soloops fires, nothing happens, and nothing anywhere says so.
 */
export async function deliver(job: DeliveryJob): Promise<DeliveryOutcome> {
  const trigger = await prisma.automationTrigger.findUnique({ where: { id: job.triggerId } })
  if (!trigger) return { ok: false, httpStatus: null, error: 'Trigger gelöscht', retryInMs: null }
  if (!trigger.enabled) {
    return { ok: false, httpStatus: null, error: 'Trigger deaktiviert', retryInMs: null }
  }

  const body = JSON.stringify(job.payload)
  const secret = openOrNull(trigger.secretEnc)
  const startedAt = Date.now()

  let httpStatus: number | null = null
  let error: string | null = null
  try {
    const res = await fetch(trigger.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Soloops-Event': job.payload.event,
        'X-Soloops-Delivery-Attempt': String(job.attempt),
        ...(secret ? { 'X-Soloops-Signature': sign(secret, body) } : {}),
      },
      body,
      // A workflow that takes longer than this has the event; waiting for its
      // answer only holds the queue.
      signal: AbortSignal.timeout(15_000),
    })
    httpStatus = res.status
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200)
      error = `HTTP ${res.status}${text ? `: ${text}` : ''}`
    }
  } catch (err) {
    error = (err as Error).message.slice(0, 200)
  }

  const ok = error === null
  const durationMs = Date.now() - startedAt

  await prisma.automationDelivery.create({
    data: {
      triggerId: trigger.id,
      event: job.event,
      ok,
      httpStatus,
      error,
      durationMs,
      attempt: job.attempt,
      payload: job.payload as unknown as object,
    },
  })

  const retry = !ok && shouldRetry(httpStatus, job.attempt)

  // The streak only moves once the attempts are exhausted — a delivery that
  // succeeds on the second try is not a failure, and should not creep a
  // trigger towards switching itself off.
  if (ok) {
    await prisma.automationTrigger.update({
      where: { id: trigger.id },
      data: { lastFiredAt: new Date(), failStreak: 0, lastError: null },
    })
  } else if (!retry) {
    const failStreak = trigger.failStreak + 1
    await prisma.automationTrigger.update({
      where: { id: trigger.id },
      data: {
        failStreak,
        lastError: error,
        // Giving up is kinder than a webhook called every time forever. The
        // view shows why, and re-enabling is one click.
        enabled: failStreak < FAIL_STREAK_LIMIT,
      },
    })
  }

  return {
    ok,
    httpStatus,
    error,
    retryInMs: retry ? backoffMs(job.attempt + 1) : null,
  }
}

/**
 * Announce a soloops event.
 *
 * Deliberately swallowing: this sits inside the request that created the
 * lead, and no automation is worth failing that. A dropped event shows up in
 * the log and in the delivery list; a 500 on "save lead" would be the actual
 * damage.
 */
export async function emitAutomationEvent(input: EmitInput): Promise<number> {
  try {
    const candidates = await prisma.automationTrigger.findMany({
      where: { event: input.event, enabled: true },
      select: { id: true, event: true, projectId: true, enabled: true },
    })
    const targets = matchTriggers(candidates, input.event, input.projectId ?? null)
    if (!targets.length) return 0

    const payload = buildPayload(input, { now: new Date(), appUrl: env.APP_URL })

    // Imported here, not at the top: the queue opens a Redis connection, and
    // the pure helpers in this file are used by tests that have no Redis.
    const { automationQueue } = await import('../queue.js')
    await Promise.all(
      targets.map((trigger) =>
        automationQueue.add(
          'dispatch',
          { triggerId: trigger.id, event: input.event, payload, attempt: 1 } satisfies DeliveryJob,
          { removeOnComplete: 200, removeOnFail: 200 },
        ),
      ),
    )
    return targets.length
  } catch (err) {
    console.error('[automations] Event nicht ausgeliefert:', (err as Error).message)
    return 0
  }
}
