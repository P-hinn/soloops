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
  SUCCESS: 'bg-good',
  FAILED: 'bg-bad',
  RUNNING: 'bg-blue',
  QUEUED: 'bg-muted',
  CANCELLED: 'bg-muted',
  UNKNOWN: 'bg-muted',
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

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>
    <p v-if="!uptimeConfigured" class="mb-4 text-sm text-muted">
      UPTIMEROBOT_API_KEY ist nicht gesetzt — Monitore bleiben leer.
    </p>

    <section class="mb-8">
      <h2 class="eyebrow mb-3">Monitore</h2>
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
              <a :href="m.url" target="_blank" class="text-xs text-muted hover:text-blue">{{ m.url }}</a>
            </td>
            <td>
              <span
                class="badge"
                :class="m.status === 2 ? 'bg-good/10 text-good' : m.status === 0 ? 'bg-paper-2 text-muted' : 'bg-bad/10 text-bad'"
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
            <td colspan="6" class="py-8 text-center text-muted">Keine Monitore synchronisiert.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="card">
      <h2 class="eyebrow mb-3">CI/CD</h2>

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
          class="border border-line bg-paper-2 p-3"
        >
          <div class="flex items-center justify-between">
            <div>
              <span class="badge bg-paper-2 text-soft">{{ repo.provider }}</span>
              <span class="ml-2 font-mono text-sm">{{ repo.slug }}</span>
              <span v-if="repo.project" class="ml-2 text-xs text-muted">{{ repo.project.key }}</span>
            </div>
            <span class="text-xs text-muted">
              {{ repo.lastSyncedAt ? new Date(repo.lastSyncedAt).toLocaleString('de-DE') : 'nie' }}
            </span>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">
            <a
              v-for="run in repo.runs"
              :key="run.id"
              :href="run.url ?? '#'"
              target="_blank"
              class="flex items-center gap-1.5 bg-paper-2 px-2 py-1 text-xs hover:bg-ink/5"
              :title="`${run.name} · ${run.branch} · ${run.status}`"
            >
              <span class="h-2 w-2 " :class="runTone[run.status]" />
              <span class="text-soft">{{ run.branch }}</span>
            </a>
            <span v-if="!repo.runs.length" class="text-xs text-muted">noch keine Läufe</span>
          </div>
        </div>
        <p v-if="!repos.length" class="text-sm text-muted">
          Noch kein Repository hinterlegt.
          <span v-if="!ciConfigured.github && !ciConfigured.gitlab">
            Erst GITHUB_TOKEN bzw. GITLAB_TOKEN setzen.
          </span>
        </p>
      </div>
    </section>
  </div>
</template>
