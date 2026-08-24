<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatDuration, formatMoney } from '@soloops/shared'
import {
  addDays,
  allDayCoversDay,
  fmtTime,
  fmtWeekday,
  isToday,
  isWeekend,
  startOfDay,
} from '@/lib/calendar'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import QuickBar from '@/components/QuickBar.vue'
import OnboardingChecklist from '@/components/OnboardingChecklist.vue'
import { useOnboarding } from '@/stores/onboarding'

type EventLite = {
  id: string
  title: string
  startsAt: string
  endsAt: string
  allDay: boolean
  project?: { key: string; color: string } | null
}

type Dashboard = {
  today: { events: EventLite[] }
  weekEvents: EventLite[]
  upcomingMeetings: { id: string; title: string; startsAt: string; client?: { name: string } | null }[]
  time: { weekSec: number; monthSec: number; unbilledSec: number; unbilledCents: number }
  money: {
    openCents: number
    openCount: number
    overdue: { id: string; number: string; client: string; totalCents: number; daysLate: number }[]
  }
  ops: {
    monitorsDown: { id: string; friendlyName: string }[]
    failedRuns: { id: string; branch: string; url: string | null; repo: { slug: string } }[]
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

/** Die kommenden sieben Tage als Spalten — der Kalender im Kleinen. */
const week = computed(() => {
  const start = startOfDay(new Date())
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(start, i)
    const from = date.getTime()
    const to = from + 86_400_000
    const events = (data.value?.weekEvents ?? []).filter((e) => {
      // Ganztägiges sind Kalendertage, keine Zeitpunkte — sonst ragt jeder
      // solche Termin bei UTC+2 zwei Stunden in den Folgetag.
      if (e.allDay) return allDayCoversDay(new Date(e.startsAt), new Date(e.endsAt), date)
      const s = new Date(e.startsAt).getTime()
      const en = new Date(e.endsAt).getTime()
      return s < to && en > from
    })
    return { date, events }
  })
})
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Lage"
      title="Dashboard"
      :subtitle="`${data?.activeProjects ?? 0} aktive Projekte`"
    >
      <template #actions>
        <RouterLink to="/calendar" class="btn-ghost">Kalender</RouterLink>
        <RouterLink to="/invoices" class="btn-primary">
          <span>Abrechnen</span><span aria-hidden="true">↗</span>
        </RouterLink>
      </template>
    </PageHeader>

    <OnboardingChecklist class="mb-5" />
    <QuickBar class="mb-10" @created="load" />

    <p v-if="loading" class="text-sm text-muted">Lade …</p>

    <template v-else-if="data">
      <!-- Die Schlagzeile trägt die Seite -->
      <p
        class="mb-10 max-w-4xl font-display text-[2.75rem] font-semibold leading-[1.05] tracking-[-0.03em]"
      >
        {{ headline }}
      </p>

      <div class="grid grid-cols-2 gap-x-8 gap-y-8 lg:grid-cols-4">
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
          :tone="data.money.overdue.length ? 'bad' : 'default'"
        />
      </div>

      <!-- ================================================================= -->
      <!-- Die nächsten sieben Tage — der Kalender im Kleinen                 -->
      <!-- ================================================================= -->
      <section class="mt-12">
        <div class="mb-3 flex items-baseline justify-between">
          <h2 class="eyebrow">Nächste sieben Tage</h2>
          <RouterLink to="/calendar" class="text-xs text-muted hover:text-blue">
            Kalender öffnen ↗
          </RouterLink>
        </div>

        <div class="tile-grid grid-cols-7">
          <div
            v-for="col in week"
            :key="col.date.toISOString()"
            class="min-h-40 bg-raised p-2"
            :class="[
              isToday(col.date) ? '!bg-acid/30' : '',
              !isToday(col.date) && isWeekend(col.date) ? '!bg-shell/50' : '',
            ]"
          >
            <div class="mb-2 flex items-baseline gap-1.5 border-b border-line pb-1.5">
              <span class="text-[10px] font-bold uppercase tracking-[0.1em] text-muted">
                {{ fmtWeekday(col.date) }}
              </span>
              <span
                class="font-display text-sm font-semibold tabular-nums"
                :class="isToday(col.date) ? 'text-ink' : 'text-soft'"
              >
                {{ col.date.getDate() }}
              </span>
              <span
                v-if="col.events.length"
                class="ml-auto font-display text-[10px] tabular-nums text-muted"
              >
                {{ col.events.length }}
              </span>
            </div>

            <ul class="space-y-1.5">
              <li
                v-for="e in col.events.slice(0, 5)"
                :key="e.id"
                class="border-l-2 pl-1.5 text-[11px] leading-tight"
                :style="{ borderColor: e.project?.color ?? 'var(--color-blue)' }"
              >
                <span v-if="!e.allDay" class="block font-display tabular-nums text-muted">
                  {{ fmtTime(new Date(e.startsAt)) }}
                </span>
                <span class="line-clamp-2 font-medium">{{ e.title }}</span>
              </li>
            </ul>
            <div v-if="col.events.length > 5" class="mt-1.5 text-[10px] text-muted">
              +{{ col.events.length - 5 }} weitere
            </div>
            <p v-if="!col.events.length" class="text-[11px] text-muted/60">frei</p>
          </div>
        </div>
      </section>

      <!-- ================================================================= -->
      <!-- Geld, Betrieb, offene Punkte                                       -->
      <!-- ================================================================= -->
      <div class="tile-grid mt-8 lg:grid-cols-3">
        <section class="tile">
          <h2 class="eyebrow mb-4">Geld</h2>

          <div v-if="data.money.overdue.length">
            <h3 class="eyebrow-muted mb-2 !text-bad">Überfällig</h3>
            <ul class="space-y-2">
              <li v-for="i in data.money.overdue" :key="i.id" class="text-sm">
                <RouterLink :to="`/invoices/${i.id}`" class="group flex items-baseline gap-2">
                  <span class="font-display text-xs text-muted">{{ i.number }}</span>
                  <span class="min-w-0 flex-1 truncate group-hover:text-blue">{{ i.client }}</span>
                  <span class="font-display tabular-nums text-bad">
                    {{ formatMoney(i.totalCents) }}
                  </span>
                </RouterLink>
                <span class="text-xs text-muted">seit {{ i.daysLate }} Tagen</span>
              </li>
            </ul>
          </div>
          <p v-else class="text-sm text-muted">Nichts überfällig.</p>

          <div v-if="data.time.unbilledCents > 0" class="mt-6 border-t border-line pt-4">
            <div class="eyebrow-muted mb-1">Bereit zur Rechnung</div>
            <div class="font-display text-2xl font-semibold tabular-nums">
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

          <div v-else class="flex items-start gap-2 text-sm">
            <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-acid ring-2 ring-ink/15" />
            <span class="text-soft">Alle Dienste laufen, alle Pipelines grün.</span>
          </div>
        </section>

        <section class="tile">
          <h2 class="eyebrow mb-4">Offene Punkte</h2>
          <ul v-if="data.openActions.length" class="space-y-2">
            <li
              v-for="a in data.openActions"
              :key="a.id"
              class="flex items-start gap-2 border-b border-line pb-2 text-sm last:border-0"
            >
              <span v-if="a.project" class="badge shrink-0">{{ a.project.key }}</span>
              <span class="min-w-0 flex-1">{{ a.title }}</span>
              <span v-if="a.dueOn" class="font-display text-xs tabular-nums text-muted">
                {{ day(a.dueOn) }}
              </span>
            </li>
          </ul>
          <p v-else class="text-sm text-muted">Nichts offen.</p>

          <template v-if="data.upcomingMeetings.length">
            <h3 class="eyebrow-muted mt-6 mb-2">Nächste Meetings</h3>
            <ul class="space-y-1.5">
              <li v-for="m in data.upcomingMeetings" :key="m.id" class="text-sm">
                <RouterLink :to="`/meetings/${m.id}`" class="hover:text-blue">
                  <span class="font-display text-xs tabular-nums text-muted">
                    {{ day(m.startsAt) }}
                  </span>
                  {{ m.title }}
                </RouterLink>
              </li>
            </ul>
          </template>
        </section>
      </div>
    </template>
  </div>
</template>
