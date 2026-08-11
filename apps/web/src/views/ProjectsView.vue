<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatDuration } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import { useTimer } from '@/stores/timer'

type Project = {
  id: string
  key: string
  name: string
  status: string
  color: string
  dueOn: string | null
  client?: { id: string; name: string; company: string | null } | null
  trackedSec: number
  unbilledSec: number
}
type Client = { id: string; name: string }

const timer = useTimer()
const projects = ref<Project[]>([])
const clients = ref<Client[]>([])
const showForm = ref(false)
const form = ref({ key: '', name: '', clientId: '', description: '', color: '#6366f1' })

const statusTone: Record<string, string> = {
  LEAD: 'badge-blue',
  ACTIVE: 'badge-good',
  PAUSED: 'badge-warn',
  DONE: '',
  ARCHIVED: '',
}

const statusLabel: Record<string, string> = {
  LEAD: 'Lead',
  ACTIVE: 'aktiv',
  PAUSED: 'pausiert',
  DONE: 'fertig',
  ARCHIVED: 'archiviert',
}

async function load() {
  projects.value = await api.get<Project[]>('/api/projects')
}

async function create() {
  await api.post('/api/projects', {
    ...form.value,
    key: form.value.key.toUpperCase(),
    clientId: form.value.clientId || null,
  })
  showForm.value = false
  form.value = { key: '', name: '', clientId: '', description: '', color: '#6366f1' }
  await load()
}

async function startTimer(projectId: string) {
  await timer.start(projectId)
}

onMounted(async () => {
  clients.value = await api.get<Client[]>('/api/clients')
  await load()
})
</script>

<template>
  <div>
    <PageHeader title="Projekte" :subtitle="`${projects.length} Projekte`">
      <template #actions>
        <button class="btn-primary" @click="showForm = !showForm">Neues Projekt</button>
      </template>
    </PageHeader>

    <form v-if="showForm" class="card mb-4 grid gap-3 md:grid-cols-4" @submit.prevent="create">
      <div>
        <label class="label">Kürzel</label>
        <input v-model="form.key" class="input uppercase" placeholder="ACME-DWH" required />
      </div>
      <div class="md:col-span-2">
        <label class="label">Name</label>
        <input v-model="form.name" class="input" required />
      </div>
      <div>
        <label class="label">Kunde</label>
        <select v-model="form.clientId" class="input">
          <option value="">Intern</option>
          <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div class="md:col-span-3">
        <label class="label">Beschreibung</label>
        <input v-model="form.description" class="input" />
      </div>
      <div class="flex items-end gap-2">
        <input v-model="form.color" type="color" class="h-9 w-12 rounded border border-line bg-paper" />
        <button class="btn-primary">Anlegen</button>
      </div>
    </form>

    <div class="border-t border-line-strong">
      <table class="table">
        <thead>
          <tr>
            <th>Projekt</th>
            <th>Kunde</th>
            <th>Status</th>
            <th class="text-right">Erfasst</th>
            <th class="text-right">Offen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id" class="hover:bg-ink/[0.035]">
            <td>
              <RouterLink :to="`/projects/${p.id}`" class="flex items-center gap-2 hover:text-blue">
                <span class="h-2.5 w-2.5 rounded-full" :style="{ background: p.color }" />
                <span class="font-mono text-xs text-muted">{{ p.key }}</span>
                <span>{{ p.name }}</span>
              </RouterLink>
            </td>
            <td class="text-soft">{{ p.client?.company ?? p.client?.name ?? 'intern' }}</td>
            <td>
              <span class="badge" :class="statusTone[p.status]">{{ statusLabel[p.status] ?? p.status }}</span>
            </td>
            <td class="text-right tabular-nums">{{ formatDuration(p.trackedSec) }} h</td>
            <td class="text-right tabular-nums" :class="p.unbilledSec > 0 ? 'text-warn' : 'text-muted'">
              {{ formatDuration(p.unbilledSec) }} h
            </td>
            <td class="text-right">
              <button class="btn-xs" @click="startTimer(p.id)">▶ Timer</button>
            </td>
          </tr>
          <tr v-if="!projects.length">
            <td colspan="6" class="py-8 text-center text-muted">Noch keine Projekte.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
