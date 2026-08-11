<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatDuration, formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

type Dashboard = {
  today: { events: { id: string; title: string; startsAt: string; endsAt: string; project?: { key: string; color: string } | null }[] }
  upcomingMeetings: { id: string; title: string; startsAt: string; project?: { key: string } | null; client?: { name: string } | null }[]
  runningTimer: { project: { key: string } } | null
  time: { weekSec: number; monthSec: number; unbilledSec: number; unbilledCents: number }
  money: {
    openCents: number
    openCount: number
    overdue: { id: string; number: string; client: string; totalCents: number; daysLate: number }[]
  }
  ops: {
    monitorsDown: { id: string; friendlyName: string; url: string }[]
    failedRuns: { id: string; name: string; branch: string; url: string | null; repo: { slug: string } }[]
  }
  openActions: { id: string; title: string; dueOn: string | null; project?: { key: string } | null }[]
  activeProjects: number
}

const data = ref<Dashboard | null>(null)
const loading = ref(true)

onMounted(async () => {
  data.value = await api.get<Dashboard>('/api/dashboard')
  loading.value = false
})

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
</script>

<template>
  <div>
    <PageHeader
      title="Dashboard"
      :subtitle="`${data?.activeProjects ?? 0} aktive Projekte`"
    />

    <p v-if="loading" class="text-sm text-zinc-500">Lade …</p>

    <template v-else-if="data">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Diese Woche" :value="formatDuration(data.time.weekSec) + ' h'" />
        <StatCard label="Diesen Monat" :value="formatDuration(data.time.monthSec) + ' h'" />
        <StatCard
          label="Nicht abgerechnet"
          :value="formatMoney(data.time.unbilledCents)"
          :hint="formatDuration(data.time.unbilledSec) + ' h offen'"
          tone="warn"
        />
        <StatCard
          label="Offene Rechnungen"
          :value="formatMoney(data.money.openCents)"
          :hint="`${data.money.openCount} Stück`"
        />
      </div>

      <div class="mt-4 grid gap-4 lg:grid-cols-3">
        <!-- Heute -->
        <section class="card">
          <h2 class="mb-3 text-sm font-semibold">Heute</h2>
          <ul v-if="data.today.events.length" class="space-y-2">
            <li v-for="e in data.today.events" :key="e.id" class="flex items-start gap-2 text-sm">
              <span class="font-mono text-xs text-zinc-500">{{ time(e.startsAt) }}</span>
              <span
                class="mt-1 h-2 w-2 shrink-0 rounded-full"
                :style="{ background: e.project?.color ?? '#52525b' }"
              />
              <span class="min-w-0 flex-1 truncate">{{ e.title }}</span>
            </li>
          </ul>
          <p v-else class="text-sm text-zinc-600">Keine Termine.</p>

          <h3 class="mt-4 mb-2 text-xs uppercase tracking-wide text-zinc-500">Nächste Meetings</h3>
          <ul class="space-y-1.5">
            <li v-for="m in data.upcomingMeetings" :key="m.id" class="text-sm">
              <RouterLink :to="`/meetings/${m.id}`" class="hover:text-indigo-400">
                <span class="font-mono text-xs text-zinc-500">{{ day(m.startsAt) }}</span>
                {{ m.title }}
                <span v-if="m.client" class="text-zinc-500">· {{ m.client.name }}</span>
              </RouterLink>
            </li>
          </ul>
        </section>

        <!-- Geld -->
        <section class="card">
          <h2 class="mb-3 text-sm font-semibold">Geld</h2>
          <div v-if="data.money.overdue.length">
            <div class="mb-1 text-xs uppercase tracking-wide text-red-400">Überfällig</div>
            <ul class="space-y-1.5">
              <li v-for="i in data.money.overdue" :key="i.id" class="text-sm">
                <RouterLink :to="`/invoices/${i.id}`" class="hover:text-indigo-400">
                  {{ i.number }} · {{ i.client }}
                  <span class="text-red-400">{{ formatMoney(i.totalCents) }}</span>
                  <span class="text-zinc-500">({{ i.daysLate }} Tage)</span>
                </RouterLink>
              </li>
            </ul>
          </div>
          <p v-else class="text-sm text-zinc-600">Nichts überfällig.</p>

          <RouterLink to="/invoices" class="btn-ghost mt-4 w-full justify-center">
            Rechnungen öffnen
          </RouterLink>
        </section>

        <!-- Betrieb -->
        <section class="card">
          <h2 class="mb-3 text-sm font-semibold">Betrieb</h2>
          <div v-if="data.ops.monitorsDown.length" class="mb-3">
            <div class="mb-1 text-xs uppercase tracking-wide text-red-400">Down</div>
            <ul class="space-y-1 text-sm">
              <li v-for="m in data.ops.monitorsDown" :key="m.id" class="truncate">
                {{ m.friendlyName }}
              </li>
            </ul>
          </div>
          <div v-if="data.ops.failedRuns.length">
            <div class="mb-1 text-xs uppercase tracking-wide text-amber-400">Pipelines rot</div>
            <ul class="space-y-1 text-sm">
              <li v-for="r in data.ops.failedRuns" :key="r.id" class="truncate">
                <a :href="r.url ?? '#'" target="_blank" class="hover:text-indigo-400">
                  {{ r.repo.slug }} · {{ r.branch }}
                </a>
              </li>
            </ul>
          </div>
          <p
            v-if="!data.ops.monitorsDown.length && !data.ops.failedRuns.length"
            class="text-sm text-emerald-500"
          >
            Alles grün.
          </p>
        </section>
      </div>

      <!-- Offene Action Items -->
      <section v-if="data.openActions.length" class="card mt-4">
        <h2 class="mb-3 text-sm font-semibold">Offene Punkte</h2>
        <ul class="space-y-1.5">
          <li v-for="a in data.openActions" :key="a.id" class="flex items-center gap-2 text-sm">
            <span v-if="a.project" class="badge bg-zinc-800 text-zinc-400">{{ a.project.key }}</span>
            <span class="flex-1">{{ a.title }}</span>
            <span v-if="a.dueOn" class="text-xs text-zinc-500">{{ day(a.dueOn) }}</span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
