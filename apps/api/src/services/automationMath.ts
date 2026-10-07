import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { AutomationRunStatus } from '@prisma/client'

/**
 * The decisions behind the automations, without any IO.
 *
 * Deliberately without a Prisma or env import — same reason as leadMath.ts:
 * retry policy, signature checking and status mapping are exactly the parts
 * worth testing, and a test should not need a database and a Redis to ask
 * whether a 404 deserves a second attempt.
 *
 * The callers re-export from here, so nobody has to know there are two files.
 */

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/** Attempt 1 is immediate; these are the waits before 2, 3 and 4. */
const BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000]

/** The widest gap, and what anything past the list falls back to. */
const BACKOFF_MAX_MS = 600_000

export const MAX_ATTEMPTS = BACKOFF_MS.length + 1

/** Past this many failures in a row a trigger switches itself off. */
export const FAIL_STREAK_LIMIT = 10

/** How long to wait before the given attempt. Attempt 1 never waits. */
export function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0
  // Beyond the listed attempts the widest gap repeats. Callers are bounded by
  // MAX_ATTEMPTS anyway; this only keeps the function total.
  return BACKOFF_MS[attempt - 2] ?? BACKOFF_MAX_MS
}

/**
 * Whether a failed attempt is worth repeating.
 *
 * A network error has no status and is always worth another go — an n8n
 * container that is restarting refuses connections for a minute or two and
 * then works again. Among HTTP answers only 408, 429 and 5xx are: everything
 * else is the receiving end saying something a repeat will not change. A 404
 * in particular means the workflow was deleted or deactivated.
 */
export function shouldRetry(httpStatus: number | null, attempt: number): boolean {
  if (attempt >= MAX_ATTEMPTS) return false
  if (httpStatus === null) return true
  if (httpStatus === 408 || httpStatus === 429) return true
  return httpStatus >= 500
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

/** The signature a receiver can check: HMAC-SHA256 over the exact body sent. */
export function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

/** Constant-time comparison, so a check cannot be probed byte by byte. */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, body), 'utf8')
  const actual = Buffer.from(signature, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function newSecret(): string {
  return randomBytes(24).toString('hex')
}

// ---------------------------------------------------------------------------
// n8n's execution status onto ours
// ---------------------------------------------------------------------------

/** The fields of an n8n execution this mapping actually reads. */
export type ExecutionStatusLike = {
  status?: string
  finished?: boolean
  startedAt?: string
  stoppedAt?: string | null
}

/**
 * n8n has changed these names more than once — `waiting` and `canceled` are
 * newer, and `finished` used to be a boolean on its own — so both are read:
 * the string when it is there, the boolean as the fallback.
 *
 * An unrecognised status becomes UNKNOWN rather than ERROR on purpose. A new
 * state in n8n should show up as odd, not as a failure that was never one.
 */
export function runStatus(execution: ExecutionStatusLike): AutomationRunStatus {
  switch (execution.status) {
    case 'new':
      return 'NEW'
    case 'running':
      return 'RUNNING'
    case 'waiting':
      return 'WAITING'
    case 'success':
      return 'SUCCESS'
    case 'error':
    case 'crashed':
    case 'failed':
      return 'ERROR'
    case 'canceled':
    case 'cancelled':
      return 'CANCELED'
  }
  if (execution.finished === true) return 'SUCCESS'
  if (execution.finished === false && execution.stoppedAt) return 'ERROR'
  if (execution.startedAt && !execution.stoppedAt) return 'RUNNING'
  return 'UNKNOWN'
}

// ---------------------------------------------------------------------------
// How a flow is doing
// ---------------------------------------------------------------------------

/** How a flow is doing, in the words the list needs. */
export type FlowHealth = 'ok' | 'failing' | 'idle' | 'missing'

export function health(flow: {
  missingSince: Date | null
  failStreak: number
  lastStatus: AutomationRunStatus | null
}): FlowHealth {
  // Order matters: a flow deleted in n8n may well also carry a failure
  // streak, and "gone" is the more useful thing to say about it.
  if (flow.missingSince) return 'missing'
  if (flow.failStreak > 0) return 'failing'
  if (!flow.lastStatus) return 'idle'
  return 'ok'
}

/**
 * Consecutive failures, newest run first.
 *
 * Runs still in flight are skipped rather than counted or treated as the end
 * of the streak: a RUNNING execution is not yet evidence either way, and
 * letting one reset the counter would hide a flow that fails every time.
 */
export function failStreakOf(runs: { status: AutomationRunStatus }[]): number {
  let streak = 0
  for (const run of runs) {
    if (run.status === 'RUNNING' || run.status === 'NEW' || run.status === 'WAITING') continue
    if (run.status === 'ERROR') streak++
    else break
  }
  return streak
}
