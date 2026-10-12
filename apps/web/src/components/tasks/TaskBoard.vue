<script setup lang="ts">
import { computed, ref } from 'vue'
import { COLUMNS, columnOf, type BoardColumn, type Task } from '@/lib/tasks'
import TaskCard from './TaskCard.vue'

/**
 * The board.
 *
 * Drag and drop with the plain HTML API — no library. What a library would
 * add here is animation; what it would cost is a dependency in the critical
 * path of the one view that has to work while you are thinking about
 * something else.
 *
 * A drop sends the **whole target column** in its new order rather than "this
 * card moved here". That is a handful of writes instead of one, and in
 * exchange there is no position arithmetic that can put two cards in the same
 * place — see services/tasks.ts on the API side.
 */

const props = defineProps<{ tasks: Task[] }>()
const emit = defineEmits<{
  open: [Task]
  toggle: [Task]
  timer: [Task]
  move: [{ column: BoardColumn; ids: string[] }]
  /** Dropped into "Erledigt" — one task closes, the column keeps its order. */
  close: [Task]
}>()

const grouped = computed(() => {
  const out: Record<BoardColumn, Task[]> = { TODO: [], DOING: [], BLOCKED: [], DONE: [] }
  for (const task of props.tasks) out[columnOf(task)].push(task)
  // Closed tasks are a log, not a queue: the last thing ticked off belongs on
  // top, and their hand-sorted position says nothing.
  out.DONE.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return out
})

/**
 * Where a card may be dropped.
 *
 * Not inside "Erledigt": that column is ordered by when things were ticked
 * off, not by hand, so a drag within it would write a new order to every row
 * and then show the old one anyway. Dropping *into* it from another column is
 * a different act — it closes the task, see onDrop.
 */
function acceptsDrop(column: BoardColumn): boolean {
  if (column !== 'DONE') return true
  return !grouped.value.DONE.some((task) => task.id === dragId.value)
}

const dragId = ref<string | null>(null)
const overColumn = ref<BoardColumn | null>(null)
/** Where the card would land — index into the column as it is shown. */
const overIndex = ref<number | null>(null)

function reset() {
  dragId.value = null
  overColumn.value = null
  overIndex.value = null
}

function onDragStart(task: Task, event: DragEvent) {
  dragId.value = task.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    // Firefox starts no drag at all without payload on the transfer.
    event.dataTransfer.setData('text/plain', task.id)
  }
}

/**
 * Over a card: the upper half means before it, the lower half after it. The
 * event stops here so the column handler below does not overwrite the index
 * with "at the end".
 */
function onDragOverCard(column: BoardColumn, index: number, event: DragEvent) {
  if (!dragId.value || !acceptsDrop(column)) return
  event.preventDefault()
  event.stopPropagation()
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const below = event.clientY > rect.top + rect.height / 2
  overColumn.value = column
  overIndex.value = index + (below ? 1 : 0)
}

/** Over the empty part of a column: at the end. */
function onDragOverColumn(column: BoardColumn, event: DragEvent) {
  if (!dragId.value || !acceptsDrop(column)) return
  event.preventDefault()
  overColumn.value = column
  overIndex.value = grouped.value[column].length
}

function onDrop(column: BoardColumn) {
  const id = dragId.value
  if (!id || !acceptsDrop(column)) return reset()

  // Into "Erledigt": tick the one card off instead of sending the column's
  // order. Sending it would rewrite every closed task's `updatedAt` in one
  // batch and scramble exactly the order that column is sorted by.
  if (column === 'DONE') {
    const task = props.tasks.find((candidate) => candidate.id === id)
    reset()
    if (task) emit('close', task)
    return
  }

  const current = grouped.value[column].map((task) => task.id)
  let index = overIndex.value ?? current.length
  const from = current.indexOf(id)
  // Dropping below its old place inside the same column: removing the card
  // first shifts everything after it up by one.
  if (from !== -1 && from < index) index -= 1

  const ids = current.filter((other) => other !== id)
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id)

  const unchanged = ids.length === current.length && ids.every((x, i) => x === current[i])
  reset()
  if (!unchanged) emit('move', { column, ids })
}

/** Button move: to the end of the target column — same split as a drop. */
function moveToEnd(task: Task, column: BoardColumn) {
  if (column === 'DONE') return emit('close', task)
  const ids = grouped.value[column].map((other) => other.id).filter((id) => id !== task.id)
  ids.push(task.id)
  emit('move', { column, ids })
}
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-4">
    <section
      v-for="col in COLUMNS"
      :key="col.key"
      class="min-w-0"
      @dragover="onDragOverColumn(col.key, $event)"
      @drop.prevent="onDrop(col.key)"
    >
      <header
        class="mb-3 flex items-baseline justify-between border-t-2 pt-2 transition-colors"
        :class="overColumn === col.key ? 'border-blue' : 'border-ink'"
      >
        <span class="eyebrow-muted" :title="col.hint">{{ col.label }}</span>
        <span class="font-display text-sm tabular-nums text-muted">
          {{ grouped[col.key].length }}
        </span>
      </header>

      <div class="min-h-24 space-y-2.5">
        <template v-for="(task, index) in grouped[col.key]" :key="task.id">
          <!-- The drop marker sits in the flow: the gap opens where the card
               will land instead of a line drawn over the neighbour. -->
          <div
            v-if="overColumn === col.key && overIndex === index && dragId !== task.id"
            class="h-0.5 bg-blue"
          />
          <div
            draggable="true"
            :class="dragId === task.id ? 'opacity-40' : ''"
            @dragstart="onDragStart(task, $event)"
            @dragend="reset"
            @dragover="onDragOverCard(col.key, index, $event)"
            @drop.prevent.stop="onDrop(col.key)"
          >
            <TaskCard
              :task="task"
              @open="emit('open', $event)"
              @toggle="emit('toggle', $event)"
              @timer="emit('timer', $event)"
              @move="moveToEnd(task, $event)"
            />
          </div>
        </template>

        <div
          v-if="overColumn === col.key && overIndex === grouped[col.key].length"
          class="h-0.5 bg-blue"
        />

        <p v-if="!grouped[col.key].length" class="py-3 text-xs text-muted">nichts</p>
      </div>
    </section>
  </div>
</template>
