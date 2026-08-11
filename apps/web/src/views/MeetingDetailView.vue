<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import MarkdownBlock from '@/components/MarkdownBlock.vue'
import { useAuth } from '@/stores/auth'

type Segment = { start: number; end: number; text: string }
type Meeting = {
  id: string
  title: string
  startsAt: string
  status: string
  participants: string[]
  agenda: string | null
  minutes: string | null
  summary: string | null
  decisions: string[] | null
  project: { id: string; key: string; name: string } | null
  client: { id: string; name: string } | null
  recording: { filename: string; durationSec: number | null; sizeBytes: number } | null
  transcript: { status: string; text: string; segments: Segment[] | null; error: string | null } | null
  actionItems: { id: string; title: string; done: boolean; assignee: string | null; dueOn: string | null }[]
}

const route = useRoute()
const auth = useAuth()
const meeting = ref<Meeting | null>(null)
const minutes = ref('')
const uploading = ref(false)
const summarizing = ref(false)
const error = ref('')
const newAction = ref('')
let poll: ReturnType<typeof setInterval> | null = null

async function load() {
  meeting.value = await api.get<Meeting>(`/api/meetings/${route.params.id}`)
  minutes.value = meeting.value.minutes ?? ''

  // Solange transkribiert wird, alle 5 s nachschauen.
  const status = meeting.value.transcript?.status
  if ((status === 'QUEUED' || status === 'RUNNING') && !poll) {
    poll = setInterval(load, 5000)
  } else if (poll && status !== 'QUEUED' && status !== 'RUNNING') {
    clearInterval(poll)
    poll = null
  }
}

async function saveMinutes() {
  await api.patch(`/api/meetings/${route.params.id}`, { minutes: minutes.value })
  await load()
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = true
  error.value = ''
  try {
    await api.upload(`/api/meetings/${route.params.id}/recording`, file)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    uploading.value = false
    input.value = ''
  }
}

async function summarize() {
  summarizing.value = true
  error.value = ''
  try {
    await api.post(`/api/meetings/${route.params.id}/summarize`)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    summarizing.value = false
  }
}

async function addAction() {
  if (!newAction.value.trim()) return
  await api.post(`/api/meetings/${route.params.id}/action-items`, { title: newAction.value })
  newAction.value = ''
  await load()
}

const clock = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

onMounted(load)
onUnmounted(() => {
  if (poll) clearInterval(poll)
})
</script>

<template>
  <div v-if="meeting">
    <PageHeader
      :title="meeting.title"
      :subtitle="`${new Date(meeting.startsAt).toLocaleString('de-DE')}${meeting.project ? ' · ' + meeting.project.key : ''}`"
    >
      <template #actions>
        <label class="btn-ghost cursor-pointer">
          {{ uploading ? 'Lade hoch …' : 'Aufnahme hochladen' }}
          <input type="file" accept="audio/*,video/*" class="hidden" @change="upload" />
        </label>
        <button
          v-if="auth.config?.features.ai"
          class="btn-primary"
          :disabled="summarizing"
          @click="summarize"
        >
          {{ summarizing ? 'Fasse zusammen …' : 'AI-Zusammenfassung' }}
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-4 text-sm text-red-400">{{ error }}</p>

    <div class="grid gap-4 lg:grid-cols-3">
      <div class="space-y-4 lg:col-span-2">
        <section v-if="meeting.summary" class="card border-indigo-900/50">
          <h2 class="mb-2 text-sm font-semibold">Zusammenfassung</h2>
          <p class="text-sm text-zinc-300">{{ meeting.summary }}</p>

          <template v-if="meeting.decisions?.length">
            <h3 class="mt-4 mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Entscheidungen</h3>
            <ul class="list-disc space-y-1 pl-4 text-sm text-zinc-300">
              <li v-for="(d, i) in meeting.decisions" :key="i">{{ d }}</li>
            </ul>
          </template>
        </section>

        <section class="card">
          <h2 class="mb-2 text-sm font-semibold">Mitschrift</h2>
          <textarea v-model="minutes" rows="8" class="input font-mono text-xs" placeholder="Markdown …" />
          <div class="mt-2 flex justify-end">
            <button class="btn-ghost" @click="saveMinutes">Speichern</button>
          </div>
        </section>

        <section v-if="meeting.transcript" class="card">
          <div class="mb-2 flex items-center justify-between">
            <h2 class="text-sm font-semibold">Transkript</h2>
            <span class="badge bg-zinc-800 text-zinc-400">{{ meeting.transcript.status }}</span>
          </div>

          <p v-if="meeting.transcript.error" class="text-sm text-red-400">
            {{ meeting.transcript.error }}
          </p>
          <p
            v-else-if="meeting.transcript.status === 'QUEUED' || meeting.transcript.status === 'RUNNING'"
            class="text-sm text-zinc-500"
          >
            Läuft lokal in faster-whisper — Seite aktualisiert sich automatisch.
          </p>

          <div v-else-if="meeting.transcript.segments?.length" class="max-h-96 space-y-1 overflow-y-auto">
            <p v-for="(s, i) in meeting.transcript.segments" :key="i" class="text-sm">
              <span class="mr-2 font-mono text-xs text-zinc-600">{{ clock(s.start) }}</span>
              <span class="text-zinc-300">{{ s.text }}</span>
            </p>
          </div>
          <p v-else class="text-sm text-zinc-300">{{ meeting.transcript.text }}</p>
        </section>

        <section v-if="meeting.agenda" class="card">
          <h2 class="mb-2 text-sm font-semibold">Agenda</h2>
          <MarkdownBlock :source="meeting.agenda" />
        </section>
      </div>

      <div class="space-y-4">
        <section class="card">
          <h2 class="mb-2 text-sm font-semibold">Action Items</h2>
          <ul class="space-y-1.5 text-sm">
            <li v-for="a in meeting.actionItems" :key="a.id" class="flex items-start gap-2">
              <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" :class="a.done ? 'bg-zinc-600' : 'bg-amber-500'" />
              <span :class="a.done ? 'text-zinc-600 line-through' : ''">{{ a.title }}</span>
            </li>
          </ul>
          <form class="mt-3 flex gap-2" @submit.prevent="addAction">
            <input v-model="newAction" class="input" placeholder="Neuer Punkt …" />
            <button class="btn-ghost">+</button>
          </form>
        </section>

        <section class="card">
          <h2 class="mb-2 text-sm font-semibold">Details</h2>
          <dl class="space-y-1.5 text-sm">
            <div class="flex justify-between">
              <dt class="text-zinc-500">Kunde</dt>
              <dd>{{ meeting.client?.name ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-zinc-500">Teilnehmende</dt>
              <dd class="text-right">{{ meeting.participants.join(', ') || '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-zinc-500">Aufnahme</dt>
              <dd>{{ meeting.recording ? meeting.recording.filename : '—' }}</dd>
            </div>
            <div v-if="meeting.recording?.durationSec" class="flex justify-between">
              <dt class="text-zinc-500">Dauer</dt>
              <dd>{{ clock(meeting.recording.durationSec) }}</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  </div>
</template>
