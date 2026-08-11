<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

type Monitor = {
  id: string
  friendlyName: string
  url: string
  status: number
  ratio24h: number | null
  ratio30d: number | null
  avgResponseMs: number | null
  projectId: string | null
  project?: { key: string } | null
  incidents: { id: string; startedAt: string; durationSec: number | null; reason: string | null }[]
}
type Run = { id: string; name: string; branch: string; status: string; url: string | null; startedAt: string | null }
type Repo = {
  id: string
  provider: string
  slug: string
  branch: string
  projectId: string | null
  lastSyncedAt: string | null
  project?: { key: string } | null
  runs: Run[]
}
type Project = { id: string; key: string }

const monitors = ref<Monitor[]>([])
const repos = ref<Repo[]>([])
const projects = ref<Project[]>([])
const uptimeConfigured = ref(false)
const ciConfigured = ref({ github: false, gitlab: false })
const busy = ref(false)
const error = ref('')

const newRepo = ref({ provider: 'GITHUB', slug: '', branch: 'main', projectId: '' })

const statusLabel: Record<number, string> = { 0: 'pausiert', 1: 'neu', 2: 'up', 8: 'wackelt', 9: 'down' }
const runTone: Record<string, string> = {
  SUCCESS: 'bg-emerald-500',
  FAILED: 'bg-red-500',
  RUNNING: 'bg-sky-500',
  QUEUED: 'bg-zinc-600',
  CANCELLED: 'bg-zinc-700',
  UNKNOWN: 'bg-zinc-700',
}

async function load() {
  const [uptime, pipelines] = await Promise.all([
    api.get<{ configured: boolean; monitors: Monitor[] }>('/api/uptime'),
    api.get<{ configured: { github: boolean; gitlab: boolean }; repos: Repo[] }>('/api/pipelines/repos'),
  ])
  monitors.value = uptime.monitors
  uptimeConfigured.value = uptime.configured
  repos.value = pipelines.repos
  ciConfigured.value = pipelines.configured
}

async function syncUptime() {
  busy.value = true
  error.value = ''
  try {
    await api.post('/api/uptime/sync')
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function syncPipelines() {
  busy.value = true
  await api.post('/api/pipelines/sync')
  setTimeout(load, 2500)
  busy.value = false
}

async function addRepo() {
  error.value = ''
  try {
    await api.post('/api/pipelines/repos', {
      ...newRepo.value,
      projectId: newRepo.value.projectId || null,
    })
    newRepo.value = { provider: 'GITHUB', slug: '', branch: 'main', projectId: '' }
    setTimeout(load, 1500)
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function assignMonitor(monitor: Monitor, projectId: string) {
  await api.patch(`/api/uptime/${monitor.id}`, { projectId: projectId || null })
  await load()
}

onMounted(async () => {
  projects.value = await api.get<Project[]>('/api/projects')
  await load()
})
</script>

<template>
  <div>
    <PageHeader title="Betrieb" subtitle="UptimeRobot und CI/CD an einem Ort">
      <template #actions>
        <button class="btn-ghost" :disabled="busy || !uptimeConfigured" @click="syncUptime">
          Uptime sync
        </button>
        <button class="btn-ghost" :disabled="busy" @click="syncPipelines">Pipelines sync</button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-4 text-sm text-red-400">{{ error }}</p>
    <p v-if="!uptimeConfigured" class="mb-4 text-sm text-zinc-500">
      UPTIMEROBOT_API_KEY ist nicht gesetzt — Monitore bleiben leer.
    </p>

    <section class="card mb-4 p-0">
      <h2 class="border-b border-zinc-800 px-4 py-3 text-sm font-semibold">Monitore</h2>
      <table class="table">
        <thead>
          <tr>
            <th>Monitor</th>
            <th>Status</th>
            <th class="text-right">24 h</th>
            <th class="text-right">30 d</th>
            <th class="text-right">Ø ms</th>
            <th>Projekt</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in monitors" :key="m.id">
            <td>
              <div>{{ m.friendlyName }}</div>
              <a :href="m.url" target="_blank" class="text-xs text-zinc-600 hover:text-indigo-400">{{ m.url }}</a>
            </td>
            <td>
              <span
                class="badge"
                :class="m.status === 2 ? 'bg-emerald-950 text-emerald-400' : m.status === 0 ? 'bg-zinc-800 text-zinc-500' : 'bg-red-950 text-red-400'"
              >
                {{ statusLabel[m.status] ?? m.status }}
              </span>
            </td>
            <td class="text-right tabular-nums">{{ m.ratio24h?.toFixed(2) ?? '—' }}</td>
            <td class="text-right tabular-nums">{{ m.ratio30d?.toFixed(2) ?? '—' }}</td>
            <td class="text-right tabular-nums">{{ m.avgResponseMs ?? '—' }}</td>
            <td>
              <select
                class="input py-1 text-xs"
                :value="m.projectId ?? ''"
                @change="assignMonitor(m, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">—</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
              </select>
            </td>
          </tr>
          <tr v-if="!monitors.length">
            <td colspan="6" class="py-8 text-center text-zinc-600">Keine Monitore synchronisiert.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2 class="mb-3 text-sm font-semibold">CI/CD</h2>

      <form class="mb-4 grid gap-3 md:grid-cols-5" @submit.prevent="addRepo">
        <select v-model="newRepo.provider" class="input">
          <option value="GITHUB">GitHub</option>
          <option value="GITLAB">GitLab</option>
        </select>
        <input v-model="newRepo.slug" class="input md:col-span-2" placeholder="owner/repo" required />
        <select v-model="newRepo.projectId" class="input">
          <option value="">Projekt —</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
        </select>
        <button class="btn-primary">Hinzufügen</button>
      </form>

      <div class="space-y-3">
        <div
          v-for="repo in repos"
          :key="repo.id"
          class="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3"
        >
          <div class="flex items-center justify-between">
            <div>
              <span class="badge bg-zinc-800 text-zinc-400">{{ repo.provider }}</span>
              <span class="ml-2 font-mono text-sm">{{ repo.slug }}</span>
              <span v-if="repo.project" class="ml-2 text-xs text-zinc-500">{{ repo.project.key }}</span>
            </div>
            <span class="text-xs text-zinc-600">
              {{ repo.lastSyncedAt ? new Date(repo.lastSyncedAt).toLocaleString('de-DE') : 'nie' }}
            </span>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <a
              v-for="run in repo.runs"
              :key="run.id"
              :href="run.url ?? '#'"
              target="_blank"
              class="flex items-center gap-1.5 rounded-md bg-zinc-900 px-2 py-1 text-xs hover:bg-zinc-800"
              :title="`${run.name} · ${run.branch} · ${run.status}`"
            >
              <span class="h-2 w-2 rounded-sm" :class="runTone[run.status]" />
              <span class="text-zinc-400">{{ run.branch }}</span>
            </a>
            <span v-if="!repo.runs.length" class="text-xs text-zinc-600">noch keine Läufe</span>
          </div>
        </div>
        <p v-if="!repos.length" class="text-sm text-zinc-600">
          Noch kein Repository hinterlegt.
          <span v-if="!ciConfigured.github && !ciConfigured.gitlab">
            Erst GITHUB_TOKEN bzw. GITLAB_TOKEN setzen.
          </span>
        </p>
      </div>
    </section>
  </div>
</template>
