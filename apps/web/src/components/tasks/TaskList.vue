<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useTimer } from '@/stores/timer'
import {
  COLUMN_LABEL,
  columnOf,
  dueLabel,
  hours,
  isFollowUpTask,
  linkBadgeClass,
  linkLabel,
  type Task,
} from '@/lib/tasks'

/**
 * The list.
 *
 * Sorted by deadline rather than by the board order: the question the list
 * answers is "what is next", and that is a date. The board answers "where
 * does this stand", which is what its columns are for.
 */

const props = defineProps<{ tasks: Task[] }>()
const emit = defineEmits<{ open: [Task]; toggle: [Task]; timer: [Task] }>()

const timer = useTimer()

/** Sorted, with the deadline worked out once per row rather than per cell. */
const rows = computed(() =>
  sorted.value.map((task) => ({ task, due: task.dueOn ? dueLabel(task.dueOn) : null })),
)

const sorted = computed(() =>
  [...props.tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1
    // Anything without a deadline sits behind everything that has one — not
    // in front, where a null date would sort by default.
    if (a.dueOn && b.dueOn) return a.dueOn.localeCompare(b.dueOn)
    if (a.dueOn) return -1
    if (b.dueOn) return 1
    return a.position - b.position || a.createdAt.localeCompare(b.createdAt)
  }),
)
</script>

<template>
  <table class="table">
    <thead>
      <tr>
        <th class="w-8"></th>
        <th>Aufgabe</th>
        <th class="w-28">Fällig</th>
        <th class="w-28">Spalte</th>
        <th>Projekt / Kunde</th>
        <th class="w-20 text-right">Zeit</th>
        <th class="w-16"></th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="{ task, due } in rows" :key="task.id">
        <td>
          <input
            type="checkbox"
            :checked="task.done"
            :title="task.done ? 'Wieder öffnen' : 'Abhaken'"
            @change="emit('toggle', task)"
          />
        </td>
        <td>
          <button class="text-left" @click="emit('open', task)">
            <span
              class="font-medium hover:text-blue"
              :class="task.done ? 'text-muted line-through' : ''"
            >
              {{ task.title }}
            </span>
          </button>
          <div
            v-if="task.links.length || task.meeting || task.lead"
            class="mt-1 flex flex-wrap gap-1"
          >
            <a
              v-for="link in task.links"
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
            <span v-if="task.meeting" class="badge" :title="task.meeting.title">Meeting</span>
            <RouterLink
              v-if="task.lead"
              :to="`/leads/${task.lead.id}`"
              class="badge badge-blue hover:border-ink"
              :title="
                isFollowUpTask(task)
                  ? `Wiedervorlage: ${task.lead.title}`
                  : `Lead: ${task.lead.title}`
              "
            >
              {{ isFollowUpTask(task) ? 'WV' : 'Lead' }}
            </RouterLink>
          </div>
        </td>
        <td class="tabular-nums">
          <span
            v-if="due"
            :class="{
              'text-bad': due.tone === 'bad' && !task.done,
              'text-warn': due.tone === 'warn' && !task.done,
              'text-muted': task.done || due.tone === 'muted',
            }"
            :title="new Date(task.dueOn!).toLocaleDateString('de-DE')"
          >
            {{ due.text }}
          </span>
          <span v-else class="text-muted">—</span>
        </td>
        <td>
          <span class="badge" :class="task.done ? 'badge-good' : ''">
            {{ COLUMN_LABEL[columnOf(task)] }}
          </span>
        </td>
        <td>
          <span v-if="task.project" class="inline-flex items-center gap-1.5">
            <span
              class="inline-block h-2 w-2 shrink-0"
              :style="{ backgroundColor: task.project.color }"
            />
            <span class="font-mono text-xs">{{ task.project.key }}</span>
          </span>
          <span v-if="task.client" class="ml-2 text-xs text-muted">{{ task.client.name }}</span>
          <span v-if="!task.project && !task.client && task.lead" class="text-xs text-muted">
            {{ task.lead.title }}
          </span>
          <span v-if="!task.project && !task.client && !task.lead" class="text-muted">—</span>
        </td>
        <td class="text-right tabular-nums">
          <span :class="task.trackedSec ? '' : 'text-muted'">
            {{ task.trackedSec ? hours(task.trackedSec) : '—' }}
          </span>
        </td>
        <td class="text-right">
          <button
            v-if="task.project && !task.done"
            class="btn-xs"
            :title="
              timer.running?.actionItem?.id === task.id
                ? 'Timer läuft'
                : 'Timer auf diese Aufgabe starten'
            "
            :disabled="timer.running?.actionItem?.id === task.id"
            @click="emit('timer', task)"
          >
            ▶
          </button>
        </td>
      </tr>
      <tr v-if="!rows.length">
        <td colspan="7" class="py-6 text-center text-sm text-muted">
          Keine Aufgabe passt auf den Filter.
        </td>
      </tr>
    </tbody>
  </table>
</template>
