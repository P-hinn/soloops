<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatDuration, formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import QuickBar from '@/components/QuickBar.vue'
import OnboardingChecklist from '@/components/OnboardingChecklist.vue'
import { useOnboarding } from '@/stores/onboarding'

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

const onboarding = useOnboarding()

async function load() {
  data.value = await api.get<Dashboard>('/api/dashboard')
  loading.value = false
  // Nach jeder Neuanlage kann sich der Einrichtungsstand geändert haben.
  if (onboarding.loaded) await onboarding.load()
}

onMounted(load)

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
const day = (iso: string) =>
  new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })

/** Ein Satz oben: was heute wirklich zählt, nach Dringlichkeit sortiert. */
const headline = computed(() => {
  const d = data.value
  if (!d) return ''
  if (d.ops.monitorsDown.length) return `${d.ops.monitorsDown.length} Dienst(e) sind unten.`
  if (d.money.overdue.length) return `${d.money.overdue.length} Rechnung(en) überfällig.`
  if (d.time.unbilledCents > 0)
    return `${formatMoney(d.time.unbilledCents)} liegen unfakturiert herum.`
  if (d.today.events.length) return `${d.today.events.length} Termin(e) stehen heute an.`
  return 'Nichts brennt.'
})

const allGreen = computed(
  () => !data.value?.ops.monitorsDown.length && !data.value?.ops.failedRuns.length,
)
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Lage"
      title="Dashboard"
      :subtitle="`${data?.activeProjects ?? 0} aktive Projekte`"
    >
      <template #actions>
        <RouterLink to="/time" class="btn-ghost">Zeiten</RouterLink>
        <RouterLink to="/invoices" class="btn-primary">
          <span>Abrechnen</span><span aria-hidden="true">↗</span>
        </RouterLink>
      </template>
    </PageHeader>

    <OnboardingChecklist class="mb-6" />

    <QuickBar class="mb-9" @created="load" />

    <p v-if="loading" class="text-sm text-muted">Lade …</p>

    <template v-else-if="data">
      <p class="mb-9 max-w-3xl font-display text-3xl font-semibold leading-[1.1] tracking-[-0.02em]">
        {{ headline }}
      </p>

      <div class="grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
        <StatCard label="Diese Woche" :value="formatDuration(data.time.weekSec) + ' h'" />
        <StatCard label="Diesen Monat" :value="formatDuration(data.time.monthSec) + ' h'" />
        <StatCard
          label="Nicht abgerechnet"
          :value="formatMoney(data.time.unbilledCents)"
          :hint="formatDuration(data.time.unbilledSec) + ' h offen'"
          :tone="data.time.unbilledCents > 0 ? 'warn' : 'default'"
        />
        <StatCard
          label="Offene Rechnungen"
          :value="formatMoney(data.money.openCents)"
          :hint="`${data.money.openCount} Stück`"
        />
      </div>

      <!-- Drei Spalten, getrennt durch Haarlinien statt durch Kästen -->
      <div class="tile-grid mt-10 lg:grid-cols-3">
        <section class="tile">
          <h2 class="eyebrow mb-4">Heute</h2>
          <ul v-if="data.today.events.length" class="space-y-2.5">
            <li v-for="e in data.today.events" :key="e.id" class="flex items-start gap-2.5 text-sm">
              <span class="font-display text-xs tabular-nums text-muted">{{ time(e.startsAt) }}</span>
              <span
                class="mt-1.5 h-1.5 w-1.5 shrink-0"
                :style="{ background: e.project?.color ?? '#6c6b64' }"
              />
              <span class="min-w-0 flex-1 truncate">{{ e.title }}</span>
            </li>
          </ul>
          <p v-else class="text-sm text-muted">Keine Termine.</p>

          <template v-if="data.upcomingMeetings.length">
            <h3 class="eyebrow-muted mt-6 mb-2">Nächste Meetings</h3>
            <ul class="space-y-1.5">
              <li v-for="m in data.upcomingMeetings" :key="m.id" class="text-sm">
                <RouterLink :to="`/meetings/${m.id}`" class="hover:text-blue">
                  <span class="font-display text-xs tabular-nums text-muted">{{ day(m.startsAt) }}</span>
                  {{ m.title }}
                  <span v-if="m.client" class="text-muted">· {{ m.client.name }}</span>
                </RouterLink>
              </li>
            </ul>
          </template>
        </section>

        <section class="tile">
          <h2 class="eyebrow mb-4">Geld</h2>
          <div v-if="data.money.overdue.length">
            <h3 class="eyebrow-muted mb-2 !text-bad">Überfällig</h3>
            <ul class="space-y-2">
              <li v-for="i in data.money.overdue" :key="i.id" class="text-sm">
                <RouterLink :to="`/invoices/${i.id}`" class="group flex items-baseline gap-2">
                  <span class="font-display text-xs text-muted">{{ i.number }}</span>
                  <span class="min-w-0 flex-1 truncate group-hover:text-blue">{{ i.client }}</span>
                  <span class="font-display tabular-nums text-bad">{{ formatMoney(i.totalCents) }}</span>
                </RouterLink>
                <span class="text-xs text-muted">seit {{ i.daysLate }} Tagen</span>
              </li>
            </ul>
          </div>
          <p v-else class="text-sm text-muted">Nichts überfällig.</p>

          <div v-if="data.time.unbilledCents > 0" class="mt-6 border-t border-line pt-4">
            <div class="eyebrow-muted mb-1">Bereit zur Rechnung</div>
            <div class="font-display text-xl font-semibold tabular-nums">
              {{ formatMoney(data.time.unbilledCents) }}
            </div>
            <RouterLink to="/invoices" class="btn-acid mt-3">
              <span>Rechnung erstellen</span><span aria-hidden="true">↗</span>
            </RouterLink>
          </div>
        </section>

        <section class="tile">
          <h2 class="eyebrow mb-4">Betrieb</h2>

          <template v-if="!allGreen">
            <div v-if="data.ops.monitorsDown.length" class="mb-4">
              <h3 class="eyebrow-muted mb-2 !text-bad">Down</h3>
              <ul class="space-y-1 text-sm">
                <li v-for="m in data.ops.monitorsDown" :key="m.id" class="truncate">
                  {{ m.friendlyName }}
                </li>
              </ul>
            </div>
            <div v-if="data.ops.failedRuns.length">
              <h3 class="eyebrow-muted mb-2 !text-warn">Pipelines rot</h3>
              <ul class="space-y-1 text-sm">
                <li v-for="r in data.ops.failedRuns" :key="r.id" class="truncate">
                  <a :href="r.url ?? '#'" target="_blank" class="hover:text-blue">
                    {{ r.repo.slug }} · {{ r.branch }}
                  </a>
                </li>
              </ul>
            </div>
          </template>

          <div v-else class="flex items-center gap-2 text-sm">
            <span class="h-2 w-2 rounded-full bg-acid" />
            <span class="text-soft">Alle Dienste laufen, alle Pipelines grün.</span>
          </div>
        </section>
      </div>

      <section v-if="data.openActions.length" class="mt-10">
        <h2 class="eyebrow mb-3">Offene Punkte</h2>
        <ul class="border-t border-line-strong">
          <li
            v-for="a in data.openActions"
            :key="a.id"
            class="flex items-center gap-3 border-b border-line py-2.5 text-sm"
          >
            <span v-if="a.project" class="badge">{{ a.project.key }}</span>
            <span class="flex-1">{{ a.title }}</span>
            <span v-if="a.dueOn" class="font-display text-xs tabular-nums text-muted">
              {{ day(a.dueOn) }}
            </span>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
