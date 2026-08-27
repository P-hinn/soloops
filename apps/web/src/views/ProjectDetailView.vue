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
  repos: {
    id: string
    slug: string
    runs: { id: string; status: string; branch: string; url: string | null }[]
  }[]
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

const healthLabel: Record<string, string> = {
  on_track: 'im Plan',
  at_risk: 'gefährdet',
  blocked: 'blockiert',
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
    <PageHeader
      :title="`${project.key} — ${project.name}`"
      :subtitle="project.client?.name ?? 'Internes Projekt'"
    >
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

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>

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

    <!-- AI-Lagebericht: der eine Block auf der Seite, der laut sein darf -->
    <section v-if="project.digests[0]" class="mt-10 border-2 border-ink">
      <div class="flex flex-wrap items-center gap-3 border-b border-ink bg-acid px-5 py-2.5">
        <span class="eyebrow-muted !text-ink">Lagebericht</span>
        <span
          v-if="project.digests[0].data"
          class="border border-ink px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em]"
        >
          {{ healthLabel[project.digests[0].data.health] ?? project.digests[0].data.health }}
        </span>
        <span class="ml-auto font-display text-xs tabular-nums text-ink/60">
          {{ new Date(project.digests[0].createdAt).toLocaleString('de-DE') }}
        </span>
      </div>

      <div class="p-5">
        <p class="font-display text-xl font-semibold leading-snug tracking-[-0.01em]">
          {{ project.digests[0].headline }}
        </p>
        <p class="mt-3 max-w-3xl leading-relaxed text-soft">{{ project.digests[0].content }}</p>

        <div v-if="project.digests[0].data" class="mt-6 grid gap-6 md:grid-cols-2">
          <div>
            <h3 class="eyebrow-muted mb-3">Nächste Schritte</h3>
            <ol class="space-y-3 text-sm">
              <li
                v-for="(a, i) in project.digests[0].data.nextActions"
                :key="i"
                class="border-l-2 border-ink pl-3"
              >
                <div class="flex items-baseline gap-2">
                  <span class="badge">{{ a.urgency }}</span>
                  <span class="font-medium">{{ a.title }}</span>
                </div>
                <span class="mt-0.5 block text-xs text-muted">{{ a.why }}</span>
              </li>
            </ol>
          </div>
          <div>
            <h3 class="eyebrow-muted mb-3">Risiken</h3>
            <ul class="space-y-2 text-sm text-soft">
              <li
                v-for="(r, i) in project.digests[0].data.risks"
                :key="i"
                class="border-l-2 border-warn/50 pl-3"
              >
                {{ r }}
              </li>
            </ul>
            <p class="mt-5 border-t border-line pt-3 text-sm text-warn">
              {{ project.digests[0].data.billingNote }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <div class="mt-4 grid gap-4 lg:grid-cols-3">
      <section class="card">
        <h2 class="eyebrow mb-3">Beschreibung</h2>
        <MarkdownBlock :source="project.description" />
      </section>

      <section class="card">
        <h2 class="eyebrow mb-3">Betrieb</h2>
        <ul class="space-y-1.5 text-sm">
          <li v-for="m in project.monitors" :key="m.id" class="flex items-center justify-between">
            <span class="truncate">{{ m.friendlyName }}</span>
            <span :class="m.status === 2 ? 'text-good' : 'text-bad'">
              {{ m.ratio30d ? m.ratio30d.toFixed(2) + '%' : '—' }}
            </span>
          </li>
        </ul>
        <ul class="mt-3 space-y-1 text-sm">
          <li v-for="repo in project.repos" :key="repo.id">
            <span class="text-muted">{{ repo.slug }}</span>
            <span
              v-for="run in repo.runs.slice(0, 5)"
              :key="run.id"
              class="ml-1 inline-block h-2 w-2"
              :class="
                run.status === 'SUCCESS'
                  ? 'bg-good'
                  : run.status === 'FAILED'
                    ? 'bg-bad'
                    : 'bg-muted'
              "
            />
          </li>
        </ul>
        <p v-if="!project.monitors.length && !project.repos.length" class="text-sm text-muted">
          Kein Monitor und kein Repo zugeordnet.
        </p>
      </section>

      <section class="card">
        <h2 class="eyebrow mb-3">Offene Punkte</h2>
        <ul class="space-y-1.5 text-sm">
          <li v-for="a in project.actionItems" :key="a.id" class="flex items-start gap-2">
            <span class="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
            <span class="flex-1">{{ a.title }}</span>
          </li>
        </ul>
        <p v-if="!project.actionItems.length" class="text-sm text-muted">Nichts offen.</p>
      </section>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <section class="card">
        <h2 class="eyebrow mb-3">Notizen</h2>
        <ul class="space-y-1 text-sm">
          <li v-for="n in project.notes_" :key="n.id">
            <RouterLink to="/notes" class="hover:text-blue">{{ n.title }}</RouterLink>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2 class="eyebrow mb-3">Meetings</h2>
        <ul class="space-y-1 text-sm">
          <li v-for="m in project.meetings" :key="m.id">
            <RouterLink :to="`/meetings/${m.id}`" class="hover:text-blue">
              <span class="font-mono text-xs text-muted">
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
