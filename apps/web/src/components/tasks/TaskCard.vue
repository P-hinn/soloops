<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useTimer } from '@/stores/timer'
import {
  COLUMNS,
  columnOf,
  dueLabel,
  hours,
  isFollowUpTask,
  linkBadgeClass,
  linkLabel,
  type BoardColumn,
  type Task,
} from '@/lib/tasks'

/**
 * One card on the board.
 *
 * Dragging is the fast path, the two arrow buttons are the other one — a
 * board that can only be operated by dragging is a board you cannot use with
 * a keyboard, and the leads pipeline next door already works by button.
 */

const props = defineProps<{ task: Task }>()
const emit = defineEmits<{
  open: [Task]
  toggle: [Task]
  timer: [Task]
  move: [BoardColumn]
}>()

const timer = useTimer()

const column = computed(() => columnOf(props.task))
const due = computed(() => (props.task.dueOn ? dueLabel(props.task.dueOn) : null))

/** Where the two arrows lead: the neighbouring columns, if there are any. */
const neighbours = computed(() => {
  const index = COLUMNS.findIndex((c) => c.key === column.value)
  return { prev: COLUMNS[index - 1] ?? null, next: COLUMNS[index + 1] ?? null }
})

const isRunning = computed(() => timer.running?.actionItem?.id === props.task.id)
</script>

<template>
  <article
    class="group border bg-raised p-3 transition-colors"
    :class="[
      isRunning ? 'border-ink bg-acid/25' : 'border-line hover:border-line-strong',
      task.done ? 'opacity-60' : '',
    ]"
  >
    <div class="flex items-start gap-2">
      <input
        type="checkbox"
        class="mt-0.5 shrink-0"
        :checked="task.done"
        :title="task.done ? 'Wieder öffnen' : 'Abhaken'"
        @change="emit('toggle', task)"
      />
      <button
        class="min-w-0 flex-1 cursor-grab text-left active:cursor-grabbing"
        @click="emit('open', task)"
      >
        <span
          class="font-display text-sm font-semibold leading-snug"
          :class="task.done ? 'line-through decoration-muted' : ''"
        >
          {{ task.title }}
        </span>
      </button>
    </div>

    <!-- Who it is for: project key with its colour, client underneath -->
    <div
      v-if="task.project || task.client"
      class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      <span v-if="task.project" class="inline-flex items-center gap-1.5 text-xs text-soft">
        <span
          class="inline-block h-2 w-2 shrink-0"
          :style="{ backgroundColor: task.project.color }"
        />
        <span class="font-mono">{{ task.project.key }}</span>
      </span>
      <span v-if="task.client" class="truncate text-xs text-muted">{{ task.client.name }}</span>
    </div>

    <!-- From a lead: the card is the follow-up, so it says so and links back -->
    <RouterLink
      v-if="task.lead"
      :to="`/leads/${task.lead.id}`"
      class="mt-1.5 flex items-center gap-1.5 text-xs text-blue hover:underline"
      :title="
        isFollowUpTask(task) ? 'Wiedervorlage — Abhaken fasst den Lead nach' : 'Aufgabe am Lead'
      "
    >
      <span class="badge badge-blue">{{ isFollowUpTask(task) ? 'WV' : 'Lead' }}</span>
      <span class="truncate">{{ task.lead.title }}</span>
    </RouterLink>

    <div class="mt-2 flex flex-wrap items-center gap-1.5">
      <span
        v-if="due"
        class="badge"
        :class="{ 'badge-bad': due.tone === 'bad', 'badge-warn': due.tone === 'warn' }"
        :title="new Date(task.dueOn!).toLocaleDateString('de-DE')"
      >
        {{ due.text }}
      </span>
      <span v-if="task.trackedSec" class="text-xs tabular-nums text-muted">
        {{ hours(task.trackedSec) }}
      </span>
      <span v-if="isRunning" class="badge badge-acid">läuft</span>
      <span v-if="task.assignee" class="text-xs text-muted">{{ task.assignee }}</span>
    </div>

    <div v-if="task.links.length" class="mt-2 flex flex-wrap gap-1">
      <a
        v-for="link in task.links.slice(0, 3)"
        :key="link.id"
        :href="link.url"
        target="_blank"
        rel="noopener"
        class="badge hover:border-ink"
        :class="linkBadgeClass(link)"
        :title="`${link.repo} · ${link.title ?? link.url}`"
      >
        {{ linkLabel(link) }}
      </a>
      <button v-if="task.links.length > 3" class="badge" @click="emit('open', task)">
        +{{ task.links.length - 3 }}
      </button>
    </div>

    <!-- Only visible on hover: the card should read as content, not as a
         toolbar with a title above it. -->
    <div
      class="mt-2.5 flex items-center gap-1 border-t border-line pt-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
    >
      <button
        v-if="neighbours.prev"
        class="btn-xs"
        :title="`Nach ${neighbours.prev.label}`"
        @click="emit('move', neighbours.prev.key)"
      >
        ←
      </button>
      <button
        v-if="neighbours.next"
        class="btn-xs"
        :title="`Nach ${neighbours.next.label}`"
        @click="emit('move', neighbours.next.key)"
      >
        →
      </button>
      <button
        v-if="task.project && !task.done"
        class="btn-xs ml-auto"
        :title="isRunning ? 'Timer läuft' : 'Timer auf diese Aufgabe starten'"
        :disabled="isRunning"
        @click="emit('timer', task)"
      >
        ▶ Zeit
      </button>
    </div>
  </article>
</template>
