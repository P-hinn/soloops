<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

type Event = {
  id: string
  title: string
  startsAt: string
  endsAt: string
  allDay: boolean
  kind: string
  location: string | null
  project?: { id: string; key: string; color: string } | null
}
type Project = { id: string; key: string; name: string }

const events = ref<Event[]>([])
const projects = ref<Project[]>([])
const weekOffset = ref(0)
const showForm = ref(false)
const feedUrl = ref('')

const form = ref({
  title: '',
  startsAt: '',
  endsAt: '',
  kind: 'FOCUS',
  projectId: '',
  location: '',
})

function startOfWeek(offset: number): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + offset * 7)
  return d
}

const weekStart = computed(() => startOfWeek(weekOffset.value))
const days = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const d = new Date(weekStart.value)
    d.setDate(d.getDate() + i)
    return d
  }),
)

const label = computed(() => {
  const end = new Date(weekStart.value)
  end.setDate(end.getDate() + 6)
  return `${weekStart.value.toLocaleDateString('de-DE')} – ${end.toLocaleDateString('de-DE')}`
})

function eventsFor(day: Date): Event[] {
  const start = day.getTime()
  const end = start + 86_400_000
  return events.value
    .filter((e) => new Date(e.startsAt).getTime() < end && new Date(e.endsAt).getTime() > start)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
}

async function load() {
  const from = weekStart.value
  const to = new Date(from)
  to.setDate(to.getDate() + 7)
  events.value = await api.get<Event[]>('/api/calendar', {
    from: from.toISOString(),
    to: to.toISOString(),
  })
}

async function shiftWeek(delta: number) {
  weekOffset.value = delta === 0 ? 0 : weekOffset.value + delta
  await load()
}

async function create() {
  await api.post('/api/calendar', {
    ...form.value,
    projectId: form.value.projectId || null,
    location: form.value.location || null,
    startsAt: new Date(form.value.startsAt).toISOString(),
    endsAt: new Date(form.value.endsAt).toISOString(),
  })
  showForm.value = false
  form.value = { title: '', startsAt: '', endsAt: '', kind: 'FOCUS', projectId: '', location: '' }
  await load()
}

async function remove(id: string) {
  if (!confirm('Termin löschen?')) return
  await api.del(`/api/calendar/${id}`)
  await load()
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

const isToday = (d: Date) => d.toDateString() === new Date().toDateString()

onMounted(async () => {
  projects.value = await api.get<Project[]>('/api/projects')
  feedUrl.value = `${location.origin}/api/calendar/feed.ics?token=<SERVICE_TOKEN>`
  await load()
})
</script>

<template>
  <div>
    <PageHeader title="Kalender" :subtitle="label">
      <template #actions>
        <button class="btn-ghost" @click="shiftWeek(-1)">‹</button>
        <button class="btn-ghost" @click="shiftWeek(0)">Heute</button>
        <button class="btn-ghost" @click="shiftWeek(1)">›</button>
        <button class="btn-primary" @click="showForm = !showForm">Termin</button>
      </template>
    </PageHeader>

    <form v-if="showForm" class="card mb-4 grid gap-3 md:grid-cols-3" @submit.prevent="create">
      <div class="md:col-span-3">
        <label class="label">Titel</label>
        <input v-model="form.title" class="input" required />
      </div>
      <div>
        <label class="label">Beginn</label>
        <input v-model="form.startsAt" type="datetime-local" class="input" required />
      </div>
      <div>
        <label class="label">Ende</label>
        <input v-model="form.endsAt" type="datetime-local" class="input" required />
      </div>
      <div>
        <label class="label">Art</label>
        <select v-model="form.kind" class="input">
          <option value="FOCUS">Fokusarbeit</option>
          <option value="MEETING">Meeting</option>
          <option value="ADMIN">Admin</option>
          <option value="TRAVEL">Reise</option>
          <option value="PERSONAL">Privat</option>
        </select>
      </div>
      <div>
        <label class="label">Projekt</label>
        <select v-model="form.projectId" class="input">
          <option value="">—</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }} — {{ p.name }}</option>
        </select>
      </div>
      <div>
        <label class="label">Ort</label>
        <input v-model="form.location" class="input" />
      </div>
      <div class="flex items-end">
        <button class="btn-primary">Anlegen</button>
      </div>
    </form>

    <div class="grid grid-cols-7 gap-2">
      <div
        v-for="d in days"
        :key="d.toISOString()"
        class="min-h-48 border p-2"
        :class="isToday(d) ? 'border-ink bg-acid/25' : 'border-line bg-paper'"
      >
        <div class="mb-2 text-xs font-medium text-soft">
          {{ d.toLocaleDateString('de-DE', { weekday: 'short' }) }}
          <span class="text-muted">{{ d.getDate() }}.</span>
        </div>
        <div
          v-for="e in eventsFor(d)"
          :key="e.id"
          class="group mb-1 border-l-2 bg-paper-2 px-2 py-1 text-xs"
          :style="{ borderColor: e.project?.color ?? '#6366f1' }"
        >
          <div class="flex items-start justify-between gap-1">
            <span class="font-mono text-[10px] text-muted">{{ time(e.startsAt) }}</span>
            <button
              class="hidden text-[10px] text-bad group-hover:block"
              @click="remove(e.id)"
            >
              ✕
            </button>
          </div>
          <div class="truncate">{{ e.title }}</div>
          <div v-if="e.project" class="text-[10px] text-muted">{{ e.project.key }}</div>
        </div>
      </div>
    </div>

    <p class="mt-4 text-xs text-muted">
      ICS-Abo für Apple/Google Kalender:
      <code class="rounded bg-paper-2 px-1.5 py-0.5">{{ feedUrl }}</code>
    </p>
  </div>
</template>
