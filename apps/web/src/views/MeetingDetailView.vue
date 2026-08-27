<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import MarkdownBlock from '@/components/MarkdownBlock.vue'
import { useAuth } from '@/stores/auth'

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
  videoUrl: string | null
  videoProvider: string | null
  project: { id: string; key: string; name: string } | null
  client: { id: string; name: string } | null
  actionItems: {
    id: string
    title: string
    done: boolean
    assignee: string | null
    dueOn: string | null
  }[]
}

const route = useRoute()
const auth = useAuth()
const meeting = ref<Meeting | null>(null)
const minutes = ref('')
const summarizing = ref(false)
const copied = ref(false)
const error = ref('')
const newAction = ref('')
const customVideo = ref('')
async function load() {
  meeting.value = await api.get<Meeting>(`/api/meetings/${route.params.id}`)
  minutes.value = meeting.value.minutes ?? ''
}

async function saveMinutes() {
  await api.patch(`/api/meetings/${route.params.id}`, { minutes: minutes.value })
  await load()
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

async function createVideo(url?: string) {
  error.value = ''
  try {
    await api.post(`/api/meetings/${route.params.id}/video`, url ? { url } : {})
    customVideo.value = ''
    await load()
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function copyVideo() {
  if (!meeting.value?.videoUrl) return
  await navigator.clipboard.writeText(meeting.value.videoUrl)
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}

async function addAction() {
  if (!newAction.value.trim()) return
  await api.post(`/api/meetings/${route.params.id}/action-items`, { title: newAction.value })
  newAction.value = ''
  await load()
}

onMounted(load)
</script>

<template>
  <div v-if="meeting">
    <PageHeader
      :title="meeting.title"
      :subtitle="`${new Date(meeting.startsAt).toLocaleString('de-DE')}${meeting.project ? ' · ' + meeting.project.key : ''}`"
    >
      <template #actions>
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

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>

    <div class="grid gap-4 lg:grid-cols-3">
      <div class="space-y-4 lg:col-span-2">
        <section v-if="meeting.summary" class="card border-ink">
          <h2 class="eyebrow mb-2">Zusammenfassung</h2>
          <p class="text-sm text-soft">{{ meeting.summary }}</p>

          <template v-if="meeting.decisions?.length">
            <h3 class="eyebrow-muted mt-5 mb-2">Entscheidungen</h3>
            <ul class="list-disc space-y-1 pl-4 text-sm text-soft">
              <li v-for="(d, i) in meeting.decisions" :key="i">{{ d }}</li>
            </ul>
          </template>
        </section>

        <section class="card">
          <h2 class="eyebrow mb-2">Mitschrift</h2>
          <textarea
            v-model="minutes"
            rows="8"
            class="input font-mono text-xs"
            placeholder="Markdown …"
          />
          <div class="mt-2 flex justify-end">
            <button class="btn-ghost" @click="saveMinutes">Speichern</button>
          </div>
        </section>

        <section v-if="meeting.agenda" class="card">
          <h2 class="eyebrow mb-2">Agenda</h2>
          <MarkdownBlock :source="meeting.agenda" />
        </section>
      </div>

      <div class="space-y-4">
        <!-- Videoraum -->
        <section class="card" :class="meeting.videoUrl ? 'border-ink' : ''">
          <h2 class="eyebrow mb-2">Videoraum</h2>

          <template v-if="meeting.videoUrl">
            <a :href="meeting.videoUrl" target="_blank" class="btn-acid w-full justify-between">
              <span>Jetzt beitreten</span><span aria-hidden="true">↗</span>
            </a>
            <p class="mt-2 break-all font-display text-[11px] text-muted">{{ meeting.videoUrl }}</p>
            <div class="mt-2 flex gap-2">
              <button class="btn-xs" @click="copyVideo">
                {{ copied ? 'kopiert' : 'Link kopieren' }}
              </button>
              <button class="btn-xs" @click="createVideo()">Neuer Raum</button>
            </div>
          </template>

          <template v-else>
            <button class="btn-primary w-full justify-center" @click="createVideo()">
              Raum anlegen
            </button>
            <form class="mt-3 flex gap-2" @submit.prevent="createVideo(customVideo)">
              <input
                v-model="customVideo"
                class="input"
                placeholder="oder eigener Link (Zoom, Teams …)"
              />
              <button class="btn-xs" :disabled="!customVideo">+</button>
            </form>
          </template>
        </section>

        <section class="card">
          <h2 class="eyebrow mb-2">Action Items</h2>
          <ul class="space-y-1.5 text-sm">
            <li v-for="a in meeting.actionItems" :key="a.id" class="flex items-start gap-2">
              <span
                class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                :class="a.done ? 'bg-muted' : 'bg-warn'"
              />
              <span :class="a.done ? 'text-muted line-through' : ''">{{ a.title }}</span>
            </li>
          </ul>
          <form class="mt-3 flex gap-2" @submit.prevent="addAction">
            <input v-model="newAction" class="input" placeholder="Neuer Punkt …" />
            <button class="btn-ghost">+</button>
          </form>
        </section>

        <section class="card">
          <h2 class="eyebrow mb-2">Details</h2>
          <dl class="space-y-1.5 text-sm">
            <div class="flex justify-between">
              <dt class="text-muted">Kunde</dt>
              <dd>{{ meeting.client?.name ?? '—' }}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-muted">Teilnehmende</dt>
              <dd class="text-right">{{ meeting.participants.join(', ') || '—' }}</dd>
            </div>
          </dl>
        </section>
      </div>
    </div>
  </div>
</template>
