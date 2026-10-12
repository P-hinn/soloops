<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatDuration } from '@soloops/shared'
import { useTimer } from '@/stores/timer'
import {
  COLUMNS,
  hours,
  isFollowUpTask,
  linkBadgeClass,
  linkLabel,
  LINK_STATE_LABEL,
  type Task,
  type TaskLink,
} from '@/lib/tasks'

/**
 * Everything about one task, in a panel over the board.
 *
 * A panel rather than its own page: the board is the place you work from, and
 * a route change would mean losing the scroll position and the filter every
 * time you look at a card.
 *
 * Fields save on change, one PATCH per field — the same way the lead detail
 * works. There is no "save" button to forget.
 */

type TimeEntry = {
  id: string
  description: string
  startedAt: string
  endedAt: string | null
  durationSec: number
  billable: boolean
  project: { id: string; key: string; name: string } | null
}

type TaskDetail = Task & { timeEntries: TimeEntry[] }

const props = defineProps<{
  taskId: string
  projects: { id: string; key: string; name: string }[]
  clients: { id: string; name: string }[]
}>()
const emit = defineEmits<{ close: []; changed: [] }>()

const timer = useTimer()
const task = ref<TaskDetail | null>(null)
const linkUrl = ref('')
const busy = ref(false)
const error = ref('')

const isRunning = computed(() => timer.running?.actionItem?.id === props.taskId)

async function load() {
  task.value = await api.get<TaskDetail>(`/api/action-items/${props.taskId}`)
}

async function patch(data: Record<string, unknown>) {
  error.value = ''
  try {
    await api.patch(`/api/action-items/${props.taskId}`, data)
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function addLink() {
  const url = linkUrl.value.trim()
  if (!url) return
  busy.value = true
  error.value = ''
  try {
    await api.post(`/api/action-items/${props.taskId}/links`, { url })
    linkUrl.value = ''
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function refreshLinks() {
  busy.value = true
  try {
    await api.post(`/api/action-items/${props.taskId}/links/refresh`)
    await load()
    emit('changed')
  } finally {
    busy.value = false
  }
}

async function removeLink(link: TaskLink) {
  await api.del(`/api/action-items/${props.taskId}/links/${link.id}`)
  await load()
  emit('changed')
}

async function startTimer() {
  error.value = ''
  try {
    await timer.start({ actionItemId: props.taskId })
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function remove() {
  const question =
    task.value && isFollowUpTask(task.value)
      ? 'Wiedervorlage samt Aufgabe löschen? Der Lead behält seinen Verlauf, aber kein Datum mehr.'
      : 'Aufgabe löschen? Erfasste Zeiten bleiben erhalten.'
  if (!confirm(question)) return
  await api.del(`/api/action-items/${props.taskId}`)
  emit('changed')
  emit('close')
}

const stamp = (value: string) =>
  new Date(value).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => {
  load()
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => window.removeEventListener('keydown', onKey))
watch(() => props.taskId, load)
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end">
    <div class="flex-1 bg-ink/25" @click="emit('close')" />

    <aside class="flex w-full max-w-lg flex-col overflow-y-auto border-l border-ink bg-paper">
      <header
        class="sticky top-0 flex items-center gap-3 border-b border-line-strong bg-paper px-5 py-3"
      >
        <span class="eyebrow">Aufgabe</span>
        <span v-if="isRunning" class="badge badge-acid">Timer läuft</span>
        <button class="btn-xs ml-auto" @click="emit('close')">Schließen ✕</button>
      </header>

      <div v-if="task" class="space-y-7 px-5 py-5">
        <p v-if="error" class="border-l-2 border-bad bg-bad/5 px-3 py-2 text-sm text-bad">
          {{ error }}
        </p>

        <!-- ----------------------------------------------------------------- -->
        <section class="space-y-4">
          <label class="label">
            Titel
            <input
              class="input font-display text-base"
              :value="task.title"
              @change="patch({ title: ($event.target as HTMLInputElement).value })"
            />
          </label>

          <div class="grid gap-4 sm:grid-cols-2">
            <label class="label">
              Fällig am
              <input
                type="date"
                class="input"
                :value="task.dueOn?.slice(0, 10) ?? ''"
                @change="patch({ dueOn: ($event.target as HTMLInputElement).value || null })"
              />
            </label>
            <label class="label">
              Spalte
              <select
                class="input"
                :value="task.done ? 'DONE' : task.status"
                @change="
                  patch(
                    ($event.target as HTMLSelectElement).value === 'DONE'
                      ? { done: true }
                      : { done: false, status: ($event.target as HTMLSelectElement).value },
                  )
                "
              >
                <option v-for="col in COLUMNS" :key="col.key" :value="col.key">
                  {{ col.label }}
                </option>
              </select>
            </label>
            <label class="label">
              Projekt
              <select
                class="input"
                :value="task.projectId ?? ''"
                @change="patch({ projectId: ($event.target as HTMLSelectElement).value || null })"
              >
                <option value="">— keines —</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">
                  {{ p.key }} — {{ p.name }}
                </option>
              </select>
            </label>
            <label class="label">
              Kunde
              <select
                class="input"
                :value="task.clientId ?? ''"
                @change="patch({ clientId: ($event.target as HTMLSelectElement).value || null })"
              >
                <option value="">— keiner —</option>
                <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
            </label>
            <label class="label sm:col-span-2">
              Zuständig
              <input
                class="input"
                placeholder="z.B. Philipp, oder ein Name beim Kunden"
                :value="task.assignee ?? ''"
                @change="patch({ assignee: ($event.target as HTMLInputElement).value || null })"
              />
            </label>
          </div>

          <p v-if="task.meeting" class="text-xs text-muted">
            Aus dem Meeting
            <RouterLink :to="`/meetings/${task.meeting.id}`" class="text-blue hover:underline">
              {{ task.meeting.title }}
            </RouterLink>
          </p>

          <!-- A follow-up's own ticket is not an ordinary task: what happens
               to the lead when you tick it off belongs on the card. -->
          <p v-if="task.lead" class="text-xs text-muted">
            <template v-if="isFollowUpTask(task)">Wiedervorlage für</template>
            <template v-else>Gehört zum Lead</template>
            <RouterLink :to="`/leads/${task.lead.id}`" class="text-blue hover:underline">
              {{ task.lead.title }}
            </RouterLink>
            <span v-if="isFollowUpTask(task)" class="mt-1 block">
              Abhaken gilt als nachgefasst und nimmt das Datum vom Lead. Löschen entfernt die
              Wiedervorlage ganz.
            </span>
          </p>
        </section>

        <!-- ----------------------------------------------------------------- -->
        <section>
          <div class="mb-3 flex items-baseline justify-between border-t-2 border-ink pt-2">
            <span class="eyebrow-muted">Code</span>
            <button
              v-if="task.links.length"
              class="btn-xs"
              :disabled="busy"
              title="Titel und Status neu lesen"
              @click="refreshLinks"
            >
              Aktualisieren
            </button>
          </div>

          <ul v-if="task.links.length" class="mb-3 space-y-2">
            <li v-for="link in task.links" :key="link.id" class="flex items-start gap-2 text-sm">
              <span class="badge mt-0.5 shrink-0" :class="linkBadgeClass(link)">
                {{ linkLabel(link) }}
              </span>
              <a
                :href="link.url"
                target="_blank"
                rel="noopener"
                class="min-w-0 flex-1 hover:text-blue"
              >
                <span class="block truncate">{{ link.title ?? link.url }}</span>
                <span class="text-xs text-muted">
                  {{ link.repo }}
                  <template v-if="link.state">
                    · {{ LINK_STATE_LABEL[link.state] ?? link.state }}
                  </template>
                  <template v-if="link.author"> · {{ link.author }}</template>
                </span>
              </a>
              <button class="btn-xs" title="Verknüpfung lösen" @click="removeLink(link)">✕</button>
            </li>
          </ul>

          <form class="flex gap-2" @submit.prevent="addLink">
            <input
              v-model="linkUrl"
              class="input flex-1"
              placeholder="PR- oder Commit-Link, oder owner/repo#12"
            />
            <button class="btn-ghost shrink-0" :disabled="busy || !linkUrl.trim()">Anhängen</button>
          </form>
          <p class="mt-1.5 text-xs text-muted">
            GitHub und GitLab. Titel und Status werden gelesen, wenn ein Token für den Host
            konfiguriert ist — sonst bleibt es die Verknüpfung allein.
          </p>
        </section>

        <!-- ----------------------------------------------------------------- -->
        <section>
          <div class="mb-3 flex items-baseline justify-between border-t-2 border-ink pt-2">
            <span class="eyebrow-muted">Zeit</span>
            <span class="font-display text-sm tabular-nums">{{ hours(task.trackedSec) }}</span>
          </div>

          <p v-if="!task.projectId" class="mb-3 text-xs text-warn">
            Ohne Projekt keine Zeiterfassung — daran hängen Stundensatz und Rechnung.
          </p>
          <button v-else-if="!isRunning" class="btn-acid mb-3" @click="startTimer">
            <span class="text-base leading-none">▶</span>
            <span>Timer starten</span>
          </button>
          <button v-else class="btn-primary mb-3" @click="timer.stop().then(load)">■ Stopp</button>

          <ul v-if="task.timeEntries.length" class="space-y-1.5 text-sm">
            <li
              v-for="entry in task.timeEntries"
              :key="entry.id"
              class="flex items-baseline gap-2 border-b border-line pb-1.5"
            >
              <span class="w-28 shrink-0 text-xs tabular-nums text-muted">
                {{ stamp(entry.startedAt) }}
              </span>
              <span class="min-w-0 flex-1 truncate">{{ entry.description || '—' }}</span>
              <span class="shrink-0 tabular-nums">
                {{ entry.endedAt ? formatDuration(entry.durationSec) : 'läuft' }}
              </span>
            </li>
          </ul>
          <p v-else class="text-sm text-muted">Noch keine Zeit auf dieser Aufgabe.</p>
        </section>

        <!-- ----------------------------------------------------------------- -->
        <footer class="flex items-center justify-between border-t border-line pt-4">
          <span class="text-xs text-muted">
            angelegt {{ stamp(task.createdAt) }} · {{ task.source }}
          </span>
          <button class="btn-danger" @click="remove">Löschen</button>
        </footer>
      </div>

      <p v-else class="px-5 py-5 text-sm text-muted">Lädt …</p>
    </aside>
  </div>
</template>
