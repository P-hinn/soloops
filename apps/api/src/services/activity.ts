/**
 * Samples become segments.
 *
 * Pure arithmetic without a database and without configuration — the tick
 * and the idle threshold come in as arguments, so that the stitching can be
 * tested without bringing an environment up.
 */

export type Sample = {
  at: Date
  bundleId: string
  appName: string
  title: string
  redacted: boolean
  idleSec: number
}

export type ActivityRun = {
  startedAt: string
  endedAt: string
  seconds: number
  bundleId: string
  appName: string
  /// The title that stood longest during this segment.
  title: string
  /// How many distinct window titles the segment saw.
  titleCount: number
  redacted: boolean
  idle: boolean
}

/** The title with the most samples. On a tie the first one wins. */
function dominantTitle(titles: string[]): { title: string; count: number } {
  const seen = new Map<string, number>()
  for (const title of titles) {
    if (!title) continue
    seen.set(title, (seen.get(title) ?? 0) + 1)
  }
  let best = ''
  let bestHits = 0
  for (const [title, hits] of seen) {
    if (hits > bestHits) {
      best = title
      bestHits = hits
    }
  }
  return { title: best, count: seen.size }
}

/**
 * Samples into segments. Every sample stands for the tick that follows it;
 * when a tick is missing (app closed, machine asleep) the segment ends
 * instead of averaging across the gap.
 *
 * Idle time ends a segment too: "editor open" and "worked in the editor" are
 * not the same thing, and only one of them belongs on an invoice later.
 */
export function buildRuns(samples: Sample[], sampleSeconds: number, idleAfter: number) {
  const tickMs = sampleSeconds * 1000
  // Two and a half ticks of tolerance: a lost tick should not tear the
  // segment apart, a real break should.
  const maxGapMs = tickMs * 2.5

  const runs: ActivityRun[] = []
  let current: (ActivityRun & { lastAt: number; titles: string[] }) | null = null

  for (const sample of samples) {
    const at = sample.at.getTime()
    const idle = sample.idleSec >= idleAfter
    const sameBlock =
      current !== null &&
      current.idle === idle &&
      (idle || current.bundleId === sample.bundleId) &&
      at - current.lastAt <= maxGapMs

    if (current && sameBlock) {
      current.lastAt = at
      current.titles.push(sample.title)
      current.redacted ||= sample.redacted
      continue
    }

    if (current) runs.push(finish(current, tickMs))
    current = {
      startedAt: sample.at.toISOString(),
      endedAt: sample.at.toISOString(),
      seconds: 0,
      bundleId: idle ? '' : sample.bundleId,
      appName: idle ? '' : sample.appName,
      title: '',
      titleCount: 0,
      redacted: sample.redacted,
      idle,
      lastAt: at,
      titles: [sample.title],
    }
  }
  if (current) runs.push(finish(current, tickMs))
  return runs
}

function finish(run: ActivityRun & { lastAt: number; titles: string[] }, tickMs: number) {
  const end = run.lastAt + tickMs
  const { title, count } = dominantTitle(run.titles)
  return {
    startedAt: run.startedAt,
    endedAt: new Date(end).toISOString(),
    seconds: Math.round((end - new Date(run.startedAt).getTime()) / 1000),
    bundleId: run.bundleId,
    appName: run.appName,
    title,
    titleCount: count,
    redacted: run.redacted,
    idle: run.idle,
  }
}
