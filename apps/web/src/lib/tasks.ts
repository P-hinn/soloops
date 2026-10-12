/**
 * The vocabulary of the task board.
 *
 * Shared by the list, the board and the detail panel so the three cannot
 * disagree about what "blockiert" is called or when a deadline turns red.
 */

export type TaskStatus = 'TODO' | 'DOING' | 'BLOCKED'
export type BoardColumn = TaskStatus | 'DONE'

export type TaskLinkKind = 'COMMIT' | 'PULL_REQUEST' | 'ISSUE'

export type TaskLink = {
  id: string
  provider: 'GITHUB' | 'GITLAB'
  kind: TaskLinkKind
  repo: string
  ref: string
  url: string
  title: string | null
  state: string | null
  author: string | null
  mergedAt: string | null
  checkedAt: string | null
}

export type Task = {
  id: string
  title: string
  done: boolean
  status: TaskStatus
  dueOn: string | null
  assignee: string | null
  /** MANUAL | AI | MCP | LEAD — see isFollowUpTask below. */
  source: string
  position: number
  projectId: string | null
  clientId: string | null
  meetingId: string | null
  leadId: string | null
  createdAt: string
  updatedAt: string
  project: { id: string; key: string; name: string; color: string } | null
  client: { id: string; name: string } | null
  meeting: { id: string; title: string } | null
  lead: { id: string; title: string; stage: string } | null
  links: TaskLink[]
  trackedSec: number
}

/**
 * A ticket a lead's follow-up keeps for itself.
 *
 * Worth telling apart in the interface: ticking it off chases the lead up and
 * writes that into its history, and deleting it takes the follow-up with it.
 * Any other task may hang on a lead without any of that happening.
 */
export function isFollowUpTask(task: Pick<Task, 'source' | 'leadId'>): boolean {
  return task.source === 'LEAD' && task.leadId !== null
}

/** The columns in board order. "Erledigt" is `done`, not a status. */
export const COLUMNS: { key: BoardColumn; label: string; hint: string }[] = [
  { key: 'TODO', label: 'Backlog', hint: 'liegt an' },
  { key: 'DOING', label: 'In Arbeit', hint: 'läuft gerade' },
  { key: 'BLOCKED', label: 'Blockiert', hint: 'wartet auf etwas' },
  { key: 'DONE', label: 'Erledigt', hint: 'abgehakt' },
]

export const COLUMN_LABEL: Record<BoardColumn, string> = {
  TODO: 'Backlog',
  DOING: 'In Arbeit',
  BLOCKED: 'Blockiert',
  DONE: 'Erledigt',
}

export function columnOf(task: Task): BoardColumn {
  return task.done ? 'DONE' : task.status
}

/** Days between today and a due date, both at local midnight. */
export function daysUntil(dueOn: string): number {
  const due = new Date(dueOn)
  const a = new Date(due.getFullYear(), due.getMonth(), due.getDate())
  const today = new Date()
  const b = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((a.getTime() - b.getTime()) / 86_400_000)
}

/**
 * How a deadline reads on a card: "heute", "2 T über", "in 5 T".
 *
 * Overdue first and in words, because a date alone makes you count — and the
 * whole point of the field is to notice without counting.
 */
export function dueLabel(dueOn: string): { text: string; tone: 'bad' | 'warn' | 'muted' } {
  const days = daysUntil(dueOn)
  if (days < 0) return { text: `${-days} T über`, tone: 'bad' }
  if (days === 0) return { text: 'heute', tone: 'bad' }
  if (days === 1) return { text: 'morgen', tone: 'warn' }
  if (days <= 7) return { text: `in ${days} T`, tone: 'warn' }
  return {
    text: new Date(dueOn).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }),
    tone: 'muted',
  }
}

/** What a link is called on a chip: `PR #12`, `abc1234`, `Issue #7`. */
export function linkLabel(link: TaskLink): string {
  if (link.kind === 'COMMIT') return link.ref.slice(0, 7)
  return `${link.kind === 'PULL_REQUEST' ? 'PR' : 'Issue'} #${link.ref}`
}

/** Merged reads as good, closed-without-merge as bad, open as neutral. */
export function linkBadgeClass(link: TaskLink): string {
  switch (link.state) {
    case 'merged':
      return 'badge-good'
    case 'closed':
      return link.kind === 'ISSUE' ? 'badge-good' : 'badge-bad'
    case 'draft':
      return 'badge-warn'
    case 'open':
      return 'badge-blue'
    default:
      return ''
  }
}

export const LINK_STATE_LABEL: Record<string, string> = {
  open: 'offen',
  closed: 'geschlossen',
  merged: 'gemerged',
  draft: 'Entwurf',
}

/** Hours as `2:05 h`, the same wording the time page uses. */
export function hours(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')} h`
}
