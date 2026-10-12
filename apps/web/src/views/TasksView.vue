<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { useTimer } from '@/stores/timer'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import TaskBoard from '@/components/tasks/TaskBoard.vue'
import TaskList from '@/components/tasks/TaskList.vue'
import TaskDrawer from '@/components/tasks/TaskDrawer.vue'
import { COLUMNS, daysUntil, hours, type BoardColumn, type Task } from '@/lib/tasks'

/**
 * Tasks — as a list and as a board.
 *
 * Everything is loaded once, including what is already done, and the filters
 * work on that copy. For a one-person workload that is a single request and
 * instant switching; a filter that goes to the server per keystroke would be
 * slower at every size this is built for.
 */

type Project = { id: string; key: string; name: string; color: string }
type Client = { id: string; name: string }

const route = useRoute()
const router = useRouter()
const timer = useTimer()

const VIEW_KEY = 'soloops.tasksView'

const tasks = ref<Task[]>([])
const projects = ref<Project[]>([])
const clients = ref<Client[]>([])
const view = ref<'board' | 'list'>(localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board')
const openId = ref<string | null>(null)
const showNew = ref(false)
const busy = ref(false)
const error = ref('')

/** Filters. `projectId` can arrive from a project page as a query parameter. */
const filter = ref({
  projectId: typeof route.query.project === 'string' ? route.query.project : '',
  clientId: typeof route.query.client === 'string' ? route.query.client : '',
  q: '',
  overdueOnly: false,
  withDone: true,
})

const draft = ref({
  title: '',
  dueOn: '',
  status: 'TODO' as Exclude<BoardColumn, 'DONE'>,
  projectId: '',
  clientId: '',
})

watch(view, (value) => localStorage.setItem(VIEW_KEY, value))

/**
 * The board needs its "Erledigt" column, so `withDone` only hides closed
 * tasks in the list. Dropping them from the board would leave the column
 * permanently empty and the drop target pointless.
 */
const visible = computed(() => {
  const needle = filter.value.q.trim().toLowerCase()
  return tasks.value.filter((task) => {
    if (filter.value.projectId && task.projectId !== filter.value.projectId) return false
    if (filter.value.clientId && task.clientId !== filter.value.clientId) return false
    if (needle && !task.title.toLowerCase().includes(needle)) return false
    if (filter.value.overdueOnly && !(task.dueOn && !task.done && daysUntil(task.dueOn) < 0))
      return false
    if (view.value === 'list' && !filter.value.withDone && task.done) return false
    return true
  })
})

const open = computed(() => visible.value.filter((task) => !task.done))

const stats = computed(() => {
  const overdue = open.value.filter((t) => t.dueOn && daysUntil(t.dueOn) < 0)
  const soon = open.value.filter(
    (t) => t.dueOn && daysUntil(t.dueOn) >= 0 && daysUntil(t.dueOn) <= 7,
  )
  const noDate = open.value.filter((t) => !t.dueOn).length
  const tracked = visible.value.reduce((sum, t) => sum + t.trackedSec, 0)
  return { open: open.value.length, overdue: overdue.length, soon: soon.length, noDate, tracked }
})

async function load() {
  const [list, projectList, clientList] = await Promise.all([
    // open=false means "not only the open ones" — the board shows both.
    api.get<Task[]>('/api/action-items', { open: false, take: 500 }),
    api.get<Project[]>('/api/projects'),
    api.get<Client[]>('/api/clients'),
  ])
  tasks.value = list
  projects.value = projectList
  clients.value = clientList
}

async function create() {
  if (!draft.value.title.trim()) return
  busy.value = true
  error.value = ''
  try {
    await api.post('/api/action-items', {
      title: draft.value.title.trim(),
      dueOn: draft.value.dueOn || null,
      status: draft.value.status,
      projectId: draft.value.projectId || null,
      // Without a project the client stands on its own; with one the API
      // fills it in from the project.
      clientId: draft.value.clientId || null,
    })
    draft.value = { ...draft.value, title: '', dueOn: '' }
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function toggle(task: Task) {
  error.value = ''
  try {
    await api.patch(`/api/action-items/${task.id}`, { done: !task.done })
  } catch (err) {
    error.value = (err as Error).message
  }
  await load()
}

/**
 * Dropped into "Erledigt".
 *
 * One write, not a whole column — the closed column is a log ordered by when
 * things were ticked off, and rewriting all of it would destroy that order.
 */
async function close(task: Task) {
  if (task.done) return
  await toggle(task)
}

async function move(payload: { column: BoardColumn; ids: string[] }) {
  // Optimistic: the card follows the pointer, the request catches up. A board
  // that snaps back for 200ms on every drop feels broken even when it works.
  const positions = new Map(payload.ids.map((id, index) => [id, index * 1000]))
  tasks.value = tasks.value.map((task) =>
    positions.has(task.id)
      ? {
          ...task,
          position: positions.get(task.id)!,
          done: payload.column === 'DONE',
          status: payload.column === 'DONE' ? task.status : payload.column,
        }
      : task,
  )
  try {
    await api.post('/api/action-items/order', payload)
  } catch (err) {
    // The reload below puts the card back where it was; without this the
    // board would simply snap and never say why.
    error.value = (err as Error).message
  } finally {
    await load()
  }
}

async function startTimer(task: Task) {
  error.value = ''
  try {
    await timer.start({ actionItemId: task.id })
    await load()
  } catch (err) {
    error.value = (err as Error).message
  }
}

/** Keep the project filter in the URL so the view can be linked to. */
watch(
  () => filter.value.projectId,
  (value) => {
    const query = { ...route.query }
    if (value) query.project = value
    else delete query.project
    router.replace({ query })
  },
)

onMounted(load)
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Arbeiten"
      title="Aufgaben"
      subtitle="Was offen ist, bis wann, für wen — und was davon schon Zeit gekostet hat."
    >
      <template #actions>
        <!-- One control, two states: the view is a toggle, not a menu. -->
        <div class="flex border border-line-strong">
          <button
            v-for="mode in ['board', 'list'] as const"
            :key="mode"
            class="px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.09em] transition-colors"
            :class="view === mode ? 'bg-ink text-paper' : 'text-soft hover:bg-ink/5'"
            @click="view = mode"
          >
            {{ mode === 'board' ? 'Board' : 'Liste' }}
          </button>
        </div>
        <button class="btn-primary" @click="showNew = !showNew">
          {{ showNew ? 'Abbrechen' : 'Neue Aufgabe' }}
        </button>
      </template>
    </PageHeader>

    <div class="tile-grid mb-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Offen"
        :value="String(stats.open)"
        :hint="stats.noDate ? stats.noDate + ' ohne Datum' : 'alle mit Datum'"
      />
      <StatCard
        label="Überfällig"
        :value="String(stats.overdue)"
        hint="über der Fälligkeit"
        :tone="stats.overdue ? 'bad' : 'default'"
      />
      <StatCard
        label="Diese Woche"
        :value="String(stats.soon)"
        hint="in den nächsten 7 Tagen"
        :tone="stats.soon ? 'warn' : 'default'"
      />
      <StatCard label="Erfasst" :value="hours(stats.tracked)" hint="auf diesen Aufgaben" />
    </div>

    <p v-if="error" class="mb-4 border-l-2 border-bad bg-bad/5 px-3 py-2 text-sm text-bad">
      {{ error }}
    </p>

    <!-- ------------------------------------------------------------------- -->
    <form v-if="showNew" class="card mb-8 space-y-4 p-5" @submit.prevent="create">
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="label sm:col-span-2">
          Was ist zu tun
          <input v-model="draft.title" class="input" placeholder="Rechnungsexport nachziehen" />
        </label>
        <label class="label">
          Fällig am <span class="font-normal normal-case tracking-normal">(optional)</span>
          <input v-model="draft.dueOn" type="date" class="input" />
        </label>
        <label class="label">
          Spalte
          <select v-model="draft.status" class="input">
            <option
              v-for="col in COLUMNS.filter((c) => c.key !== 'DONE')"
              :key="col.key"
              :value="col.key"
            >
              {{ col.label }}
            </option>
          </select>
        </label>
        <label class="label">
          Projekt
          <select v-model="draft.projectId" class="input">
            <option value="">— keines —</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">
              {{ p.key }} — {{ p.name }}
            </option>
          </select>
        </label>
        <label class="label">
          Kunde
          <select v-model="draft.clientId" class="input">
            <option value="">— vom Projekt —</option>
            <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
      </div>
      <p class="text-xs text-muted">
        Projekt oder Kunde entscheiden, worauf die Zeit gebucht wird. Ohne Projekt ist die Aufgabe
        nur eine Notiz mit Datum — Zeiterfassung braucht eines.
      </p>
      <button class="btn-acid" :disabled="busy || !draft.title.trim()">Anlegen</button>
    </form>

    <!-- ------------------------------------------------------------------- -->
    <div class="mb-5 flex flex-wrap items-end gap-3">
      <label class="label">
        Projekt
        <select v-model="filter.projectId" class="input w-48">
          <option value="">alle</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
        </select>
      </label>
      <label class="label">
        Kunde
        <select v-model="filter.clientId" class="input w-48">
          <option value="">alle</option>
          <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label class="label min-w-56 flex-1">
        Suche
        <input v-model="filter.q" class="input" placeholder="im Titel" />
      </label>
      <label class="flex items-center gap-2 pb-2.5 text-sm">
        <input v-model="filter.overdueOnly" type="checkbox" /> nur überfällig
      </label>
      <label v-if="view === 'list'" class="flex items-center gap-2 pb-2.5 text-sm">
        <input v-model="filter.withDone" type="checkbox" /> Erledigte zeigen
      </label>
    </div>

    <TaskBoard
      v-if="view === 'board'"
      :tasks="visible"
      @open="openId = $event.id"
      @toggle="toggle"
      @timer="startTimer"
      @move="move"
      @close="close"
    />
    <TaskList
      v-else
      :tasks="visible"
      @open="openId = $event.id"
      @toggle="toggle"
      @timer="startTimer"
    />

    <TaskDrawer
      v-if="openId"
      :task-id="openId"
      :projects="projects"
      :clients="clients"
      @close="openId = null"
      @changed="load"
    />
  </div>
</template>
