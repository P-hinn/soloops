/**
 * Which schedules have to be rewritten.
 *
 * The worker sets up its repeating jobs once at startup. With the intervals
 * in the `.env` that was enough — the file could not change without a
 * restart. Now they can be changed in the interface, and a cron that only
 * takes effect after `docker compose restart worker` is a setting that lies.
 *
 * So the worker compares what it has planned against what is in force and
 * rewrites the difference. `upsertJobScheduler` is idempotent, so rewriting
 * is cheap — but doing it every minute for every schedule would be a write
 * to Redis per schedule per minute for nothing, which is why this returns
 * only what actually moved.
 */

export type Schedules = Record<string, string>

/**
 * The keys whose pattern differs, sorted so a log line reads the same way
 * twice.
 *
 * A schedule that has disappeared from `next` is not returned: switching a
 * service off is the job of the condition that guards it, not of this
 * comparison.
 */
export function changedSchedules(planned: Schedules, next: Schedules): string[] {
  return Object.keys(next)
    .filter((key) => planned[key] !== next[key])
    .sort()
}
