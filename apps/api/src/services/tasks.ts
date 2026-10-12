import type { TaskStatus } from '@prisma/client'

/**
 * The board behind the to-do list.
 *
 * Two fields carry it: `done` says whether a task is closed, `status` which
 * of the open columns it sits in. The last column of the board is therefore
 * `done`, not a status — see the enum's note in schema.prisma for why. The
 * consequence worth knowing is pleasant: dragging a card out of "Erledigt"
 * puts it back where it came from, because its status was never overwritten.
 */

export const BOARD_COLUMNS = ['TODO', 'DOING', 'BLOCKED', 'DONE'] as const

export type BoardColumn = (typeof BOARD_COLUMNS)[number]

/**
 * The write that moves a task into a column.
 *
 * Only "Erledigt" leaves the status alone; every other column is a status and
 * reopens the task on the way in.
 */
export function columnPatch(column: BoardColumn): { done: boolean; status?: TaskStatus } {
  if (column === 'DONE') return { done: true }
  return { done: false, status: column }
}

/**
 * The gap between two cards.
 *
 * Positions are spaced rather than consecutive so a card dropped between two
 * others gets the average and nothing else has to be rewritten. The gap only
 * runs out after about ten drops onto the same spot, and the reorder below
 * hands out fresh multiples whenever it touches a column anyway.
 */
export const POSITION_STEP = 1000

/** Where a new card goes: after everything that is already in the column. */
export function nextPosition(taken: readonly number[]): number {
  if (taken.length === 0) return 0
  return Math.max(...taken) + POSITION_STEP
}

/**
 * Positions for a column that was just reordered, in the given order.
 *
 * The frontend sends the whole column rather than one moved card, which costs
 * a handful of writes and buys the one property that matters: there is no
 * arithmetic that can produce two cards claiming the same spot, so the board
 * cannot end up in an order nobody asked for.
 */
export function spreadPositions(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index * POSITION_STEP)
}

// ---------------------------------------------------------------------------
// The ticket a follow-up carries
// ---------------------------------------------------------------------------

/**
 * The marker that says a ticket belongs to a lead's follow-up rather than to
 * you. Only those are opened, moved and closed with the follow-up — see
 * services/leadTasks.ts, which does the writing.
 */
export const FOLLOW_UP_SOURCE = 'LEAD'

/**
 * Both halves have to match: a task you wrote yourself on a lead carries the
 * `leadId` too, and ticking it off must not count as having chased anyone up.
 */
export function isFollowUpTask(task: { source: string; leadId: string | null }): boolean {
  return task.source === FOLLOW_UP_SOURCE && task.leadId !== null
}

/**
 * What the card says.
 *
 * The lead's title alone would read as a duplicate of the lead; the reason
 * alone ("Angebot nachfassen") loses who it is about. Both, in the order you
 * scan a board in: who first, then what.
 */
export function followUpTaskTitle(leadTitle: string, note?: string | null): string {
  const reason = note?.trim()
  return reason ? `Wiedervorlage ${leadTitle}: ${reason}` : `Wiedervorlage: ${leadTitle}`
}
