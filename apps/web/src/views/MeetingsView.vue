<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

type Meeting = {
  id: string
  title: string
  startsAt: string
  status: string
  participants: string[]
  project?: { key: string; color: string } | null
  client?: { name: string } | null
  videoUrl?: string | null
  _count: { actionItems: number }
}
type Project = { id: string; key: string; name: string }

const meetings = ref<Meeting[]>([])
const projects = ref<Project[]>([])
const showForm = ref(false)
const form = ref({
  title: '',
  startsAt: '',
  endsAt: '',
  projectId: '',
  participants: '',
  agenda: '',
  withVideo: true,
})

async function load() {
  meetings.value = await api.get<Meeting[]>('/api/meetings')
}

async function create() {
  await api.post('/api/meetings', {
    title: form.value.title,
    startsAt: new Date(form.value.startsAt).toISOString(),
    endsAt: form.value.endsAt ? new Date(form.value.endsAt).toISOString() : null,
    projectId: form.value.projectId || null,
    participants: form.value.participants
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    agenda: form.value.agenda || null,
    withVideo: form.value.withVideo,
  })
  showForm.value = false
  form.value = {
    title: '',
    startsAt: '',
    endsAt: '',
    projectId: '',
    participants: '',
    agenda: '',
    withVideo: true,
  }
  await load()
}

onMounted(async () => {
  projects.value = await api.get<Project[]>('/api/projects')
  await load()
})
</script>

<template>
  <div>
    <PageHeader title="Meetings" subtitle="Termine, Mitschriften, Transkripte">
      <template #actions>
        <button class="btn-primary" @click="showForm = !showForm">Neues Meeting</button>
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
        <input v-model="form.endsAt" type="datetime-local" class="input" />
      </div>
      <div>
        <label class="label">Projekt</label>
        <select v-model="form.projectId" class="input">
          <option value="">—</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
        </select>
      </div>
      <div class="md:col-span-2">
        <label class="label">Teilnehmende (kommagetrennt)</label>
        <input v-model="form.participants" class="input" />
      </div>
      <div class="flex items-end gap-3">
        <label
          class="flex items-center gap-2 pb-2 text-sm"
          title="Erzeugt einen Jitsi-Raum, kein Konto nötig"
        >
          <input v-model="form.withVideo" type="checkbox" /> Videoraum
        </label>
        <button class="btn-primary">Anlegen</button>
      </div>
      <div class="md:col-span-3">
        <label class="label">Agenda (Markdown)</label>
        <textarea v-model="form.agenda" rows="3" class="input font-mono text-xs" />
      </div>
    </form>

    <div class="border-t border-line-strong">
      <table class="table">
        <thead>
          <tr>
            <th>Datum</th>
            <th>Meeting</th>
            <th>Projekt</th>
            <th>Video</th>
            <th class="text-right">Punkte</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in meetings" :key="m.id" class="hover:bg-ink/[0.035]">
            <td class="whitespace-nowrap font-mono text-xs text-muted">
              {{
                new Date(m.startsAt).toLocaleString('de-DE', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })
              }}
            </td>
            <td>
              <RouterLink :to="`/meetings/${m.id}`" class="hover:text-blue">{{
                m.title
              }}</RouterLink>
              <span v-if="m.client" class="ml-2 text-xs text-muted">{{ m.client.name }}</span>
            </td>
            <td>
              <span v-if="m.project" class="badge bg-paper-2 text-soft">{{ m.project.key }}</span>
            </td>
            <td>
              <a v-if="m.videoUrl" :href="m.videoUrl" target="_blank" class="btn-xs" @click.stop>
                ▶ Beitreten
              </a>
              <span v-else class="text-xs text-muted">—</span>
            </td>
            <td class="text-right tabular-nums">{{ m._count.actionItems }}</td>
          </tr>
          <tr v-if="!meetings.length">
            <td colspan="5" class="py-8 text-center text-muted">Noch keine Meetings.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
