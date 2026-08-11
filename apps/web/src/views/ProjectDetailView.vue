<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatDuration, formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import MarkdownBlock from '@/components/MarkdownBlock.vue'
import { useTimer } from '@/stores/timer'
import { useAuth } from '@/stores/auth'

type Digest = {
  id: string
  headline: string
  content: string
  createdAt: string
  data: {
    health: 'on_track' | 'at_risk' | 'blocked'
    nextActions: { title: string; why: string; urgency: string }[]
    risks: string[]
    billingNote: string
  } | null
}

type Project = {
  id: string
  key: string
  name: string
  description: string | null
  status: string
  color: string
  client: { id: string; name: string } | null
  trackedSec: number
  unbilledSec: number
  invoicedCents: number
  monitors: { id: string; friendlyName: string; status: number; ratio30d: number | null }[]
  repos: { id: string; slug: string; runs: { id: string; status: string; branch: string; url: string | null }[] }[]
  notes_: { id: string; title: string; updatedAt: string }[]
  meetings: { id: string; title: string; startsAt: string }[]
  actionItems: { id: string; title: string; dueOn: string | null; done: boolean }[]
  digests: Digest[]
}

const route = useRoute()
const timer = useTimer()
const auth = useAuth()
const project = ref<Project | null>(null)
const digesting = ref(false)
const error = ref('')

const healthTone: Record<string, string> = {
  on_track: 'bg-emerald-950 text-emerald-400',
  at_risk: 'bg-amber-950 text-amber-400',
  blocked: 'bg-red-950 text-red-400',
}

async function load() {
  project.value = await api.get<Project>(`/api/projects/${route.params.id}`)
}

async function refreshDigest() {
  digesting.value = true
  error.value = ''
  try {
    await api.post(`/api/projects/${route.params.id}/digest`)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    digesting.value = false
  }
}

onMounted(load)
</script>

<template>
  <div v-if="project">
    <PageHeader :title="`${project.key} — ${project.name}`" :subtitle="project.client?.name ?? 'Internes Projekt'">
      <template #actions>
        <button class="btn-ghost" @click="timer.start(project!.id)">▶ Timer starten</button>
        <button
          v-if="auth.config?.features.ai"
          class="btn-primary"
          :disabled="digesting"
          @click="refreshDigest"
        >
          {{ digesting ? 'Analysiere …' : 'AI-Lagebericht' }}
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-4 text-sm text-red-400">{{ error }}</p>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Erfasst" :value="formatDuration(project.trackedSec) + ' h'" />
      <StatCard
        label="Nicht abgerechnet"
        :value="formatDuration(project.unbilledSec) + ' h'"
        tone="warn"
      />
      <StatCard label="Fakturiert" :value="formatMoney(project.invoicedCents)" />
      <StatCard label="Offene Punkte" :value="String(project.actionItems.length)" />
    </div>

    <!-- AI-Lagebericht -->
    <section v-if="project.digests[0]" class="card mt-4 border-indigo-900/50">
      <div class="mb-2 flex items-center gap-2">
        <span class="badge bg-indigo-950 text-indigo-400">AI-Lagebericht</span>
        <span
          v-if="project.digests[0].data"
          class="badge"
          :class="healthTone[project.digests[0].data.health]"
        >
          {{ project.digests[0].data.health }}
        </span>
        <span class="text-xs text-zinc-600">
          {{ new Date(project.digests[0].createdAt).toLocaleString('de-DE') }}
        </span>
      </div>
      <p class="font-medium">{{ project.digests[0].headline }}</p>
      <p class="mt-2 text-sm text-zinc-300">{{ project.digests[0].content }}</p>

      <div v-if="project.digests[0].data" class="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h3 class="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Nächste Schritte</h3>
          <ul class="space-y-1.5 text-sm">
            <li v-for="(a, i) in project.digests[0].data.nextActions" :key="i">
              <span class="badge bg-zinc-800 text-zinc-400">{{ a.urgency }}</span>
              {{ a.title }}
              <span class="block text-xs text-zinc-500">{{ a.why }}</span>
            </li>
          </ul>
        </div>
        <div>
          <h3 class="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">Risiken</h3>
          <ul class="list-disc space-y-1 pl-4 text-sm text-zinc-300">
            <li v-for="(r, i) in project.digests[0].data.risks" :key="i">{{ r }}</li>
          </ul>
          <p class="mt-3 text-sm text-amber-400">{{ project.digests[0].data.billingNote }}</p>
        </div>
      </div>
    </section>

    <div class="mt-4 grid gap-4 lg:grid-cols-3">
      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Beschreibung</h2>
        <MarkdownBlock :source="project.description" />
      </section>

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Betrieb</h2>
        <ul class="space-y-1.5 text-sm">
          <li v-for="m in project.monitors" :key="m.id" class="flex items-center justify-between">
            <span class="truncate">{{ m.friendlyName }}</span>
            <span :class="m.status === 2 ? 'text-emerald-400' : 'text-red-400'">
              {{ m.ratio30d ? m.ratio30d.toFixed(2) + '%' : '—' }}
            </span>
          </li>
        </ul>
        <ul class="mt-3 space-y-1 text-sm">
          <li v-for="repo in project.repos" :key="repo.id">
            <span class="text-zinc-500">{{ repo.slug }}</span>
            <span
              v-for="run in repo.runs.slice(0, 5)"
              :key="run.id"
              class="ml-1 inline-block h-2 w-2 rounded-sm"
              :class="run.status === 'SUCCESS' ? 'bg-emerald-500' : run.status === 'FAILED' ? 'bg-red-500' : 'bg-zinc-600'"
            />
          </li>
        </ul>
        <p v-if="!project.monitors.length && !project.repos.length" class="text-sm text-zinc-600">
          Kein Monitor und kein Repo zugeordnet.
        </p>
      </section>

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Offene Punkte</h2>
        <ul class="space-y-1.5 text-sm">
          <li v-for="a in project.actionItems" :key="a.id" class="flex items-start gap-2">
            <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
            <span class="flex-1">{{ a.title }}</span>
          </li>
        </ul>
        <p v-if="!project.actionItems.length" class="text-sm text-zinc-600">Nichts offen.</p>
      </section>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Notizen</h2>
        <ul class="space-y-1 text-sm">
          <li v-for="n in project.notes_" :key="n.id">
            <RouterLink to="/notes" class="hover:text-indigo-400">{{ n.title }}</RouterLink>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Meetings</h2>
        <ul class="space-y-1 text-sm">
          <li v-for="m in project.meetings" :key="m.id">
            <RouterLink :to="`/meetings/${m.id}`" class="hover:text-indigo-400">
              <span class="font-mono text-xs text-zinc-500">
                {{ new Date(m.startsAt).toLocaleDateString('de-DE') }}
              </span>
              {{ m.title }}
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
