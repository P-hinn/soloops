<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api'
import { formatDuration, formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import TimerControl from '@/components/TimerControl.vue'

type Entry = {
  id: string
  projectId: string
  description: string
  startedAt: string
  endedAt: string | null
  durationSec: number
  billable: boolean
  rateCents: number | null
  invoiceItemId: string | null
  project: { id: string; key: string; name: string; color: string }
}
type Project = { id: string; key: string; name: string }
type Report = {
  totalSeconds: number
  totalValueCents: number
  rows: {
    projectId: string
    projectKey: string
    projectName: string
    clientName: string | null
    hours: number
    valueCents: number
  }[]
}

const entries = ref<Entry[]>([])
const projects = ref<Project[]>([])
const report = ref<Report | null>(null)

const today = new Date()
const from = ref(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10))
const to = ref(today.toISOString().slice(0, 10))

const manual = ref({ projectId: '', description: '', startedAt: '', endedAt: '', billable: true })
const showManual = ref(false)

const unbilledSec = computed(() =>
  entries.value
    .filter((e) => e.billable && !e.invoiceItemId)
    .reduce((s, e) => s + e.durationSec, 0),
)

async function load() {
  entries.value = await api.get<Entry[]>('/api/time', {
    from: new Date(from.value).toISOString(),
    to: new Date(`${to.value}T23:59:59`).toISOString(),
  })
  report.value = await api.get<Report>('/api/time/report', {
    from: new Date(from.value).toISOString(),
    to: new Date(`${to.value}T23:59:59`).toISOString(),
  })
}

async function addManual() {
  await api.post('/api/time', {
    projectId: manual.value.projectId,
    description: manual.value.description,
    startedAt: new Date(manual.value.startedAt).toISOString(),
    endedAt: new Date(manual.value.endedAt).toISOString(),
    billable: manual.value.billable,
  })
  showManual.value = false
  manual.value = { projectId: '', description: '', startedAt: '', endedAt: '', billable: true }
  await load()
}

async function remove(entry: Entry) {
  if (!confirm('Eintrag löschen?')) return
  await api.del(`/api/time/${entry.id}`)
  await load()
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
const date = (iso: string) => new Date(iso).toLocaleDateString('de-DE')

onMounted(async () => {
  projects.value = await api.get<Project[]>('/api/projects')
  await load()
})
</script>

<template>
  <div>
    <PageHeader title="Zeiten" subtitle="Stoppuhr, Nachträge und Auswertung">
      <template #actions>
        <button class="btn-ghost" @click="showManual = !showManual">
          {{ showManual ? 'Nachtrag schließen' : 'Zeit nachtragen' }}
        </button>
      </template>
    </PageHeader>

    <!-- Die Stoppuhr gehört hierher, nicht in eine Projektzeile. -->
    <TimerControl class="mb-6" :projects="projects" :recent="entries" @changed="load" />

    <form v-if="showManual" class="card mb-4 grid gap-3 md:grid-cols-5" @submit.prevent="addManual">
      <div>
        <label class="label">Projekt</label>
        <select v-model="manual.projectId" class="input" required>
          <option value="" disabled>wählen …</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
        </select>
      </div>
      <div class="md:col-span-2">
        <label class="label">Beschreibung</label>
        <input v-model="manual.description" class="input" />
      </div>
      <div>
        <label class="label">Von</label>
        <input v-model="manual.startedAt" type="datetime-local" class="input" required />
      </div>
      <div>
        <label class="label">Bis</label>
        <input v-model="manual.endedAt" type="datetime-local" class="input" required />
      </div>
      <div class="md:col-span-5 flex items-center gap-3">
        <label class="flex items-center gap-2 text-sm">
          <input v-model="manual.billable" type="checkbox" class="accent-ink" /> abrechenbar
        </label>
        <button class="btn-primary">Eintragen</button>
      </div>
    </form>

    <div class="mb-4 flex items-end gap-3">
      <div>
        <label class="label">Von</label>
        <input v-model="from" type="date" class="input" @change="load" />
      </div>
      <div>
        <label class="label">Bis</label>
        <input v-model="to" type="date" class="input" @change="load" />
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Zeitraum gesamt" :value="formatDuration(report?.totalSeconds ?? 0) + ' h'" />
      <StatCard label="Gegenwert" :value="formatMoney(report?.totalValueCents ?? 0)" />
      <StatCard label="Nicht abgerechnet" :value="formatDuration(unbilledSec) + ' h'" tone="warn" />
      <StatCard label="Einträge" :value="String(entries.length)" />
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
      <div class="border-t border-line-strong">
        <table class="table">
          <thead>
            <tr>
              <th>Datum</th>
              <th>Projekt</th>
              <th>Beschreibung</th>
              <th class="text-right">Dauer</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="e in entries" :key="e.id" class="hover:bg-ink/[0.035]">
              <td class="whitespace-nowrap text-xs text-muted">
                {{ date(e.startedAt) }}
                <span class="block"
                  >{{ time(e.startedAt) }}–{{ e.endedAt ? time(e.endedAt) : '…' }}</span
                >
              </td>
              <td>
                <span
                  class="badge"
                  :style="{ background: e.project.color + '22', color: e.project.color }"
                >
                  {{ e.project.key }}
                </span>
              </td>
              <td>
                {{ e.description || '—' }}
                <span v-if="e.invoiceItemId" class="ml-1 badge bg-paper-2 text-muted"
                  >fakturiert</span
                >
                <span v-else-if="!e.billable" class="ml-1 badge bg-paper-2 text-muted"
                  >nicht abrechenbar</span
                >
              </td>
              <td class="text-right tabular-nums">{{ formatDuration(e.durationSec) }}</td>
              <td class="text-right">
                <button
                  v-if="!e.invoiceItemId"
                  class="text-xs text-bad hover:underline"
                  @click="remove(e)"
                >
                  ✕
                </button>
              </td>
            </tr>
            <tr v-if="!entries.length">
              <td colspan="5" class="py-8 text-center text-muted">Keine Einträge im Zeitraum.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2 class="eyebrow mb-3">Nach Projekt</h2>
        <ul class="space-y-2 text-sm">
          <li v-for="r in report?.rows ?? []" :key="r.projectId">
            <div class="flex items-baseline justify-between">
              <span class="font-mono text-xs text-muted">{{ r.projectKey }}</span>
              <span class="tabular-nums">{{ r.hours }} h</span>
            </div>
            <div class="flex items-baseline justify-between text-xs text-muted">
              <span class="truncate">{{ r.clientName ?? 'intern' }}</span>
              <span>{{ formatMoney(r.valueCents) }}</span>
            </div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
