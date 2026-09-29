<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import { formatDuration } from '@soloops/shared'

/**
 * The day band: what ran on the machine, as stripes over an hour axis.
 *
 * No mapping to projects yet — this is what was measured, nothing more.
 * Anything you would rather not see can be deleted row by row.
 */

type Run = {
  startedAt: string
  endedAt: string
  seconds: number
  bundleId: string
  appName: string
  title: string
  titleCount: number
  redacted: boolean
  idle: boolean
}

type Day = {
  date: string
  sampleSeconds: number
  idleAfterSec: number
  retentionDays: number
  lastSampleAt: string | null
  activeSeconds: number
  idleSeconds: number
  runs: Run[]
  apps: { bundleId: string; appName: string; seconds: number }[]
}

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const day = ref(iso(new Date()))
const data = ref<Day | null>(null)
const loading = ref(false)

/** Segments from half a minute up — shorter ones are clicks, not work. */
const visible = computed(() => (data.value?.runs ?? []).filter((r) => r.seconds >= 30))

/**
 * The axis spans whatever the day holds, but at least eight hours:
 * otherwise a single segment in the morning blows the band up to full width
 * and pretends to be a working day.
 */
const scale = computed(() => {
  const runs = visible.value
  const fallback = new Date(`${day.value}T08:00:00`).getTime()
  if (!runs.length) return { from: fallback, to: fallback + 8 * 3600_000 }

  const first = new Date(runs[0].startedAt).getTime()
  const last = new Date(runs[runs.length - 1].endedAt).getTime()
  const from = Math.floor(first / 3600_000) * 3600_000
  const to = Math.max(Math.ceil(last / 3600_000) * 3600_000, from + 8 * 3600_000)
  return { from, to }
})

const hours = computed(() => {
  const out: { at: number; label: string }[] = []
  for (let at = scale.value.from; at <= scale.value.to; at += 3600_000) {
    out.push({ at, label: new Date(at).toLocaleTimeString('de-DE', { hour: '2-digit' }) })
  }
  return out
})

const offset = (ms: number) => ((ms - scale.value.from) / (scale.value.to - scale.value.from)) * 100

function place(run: Run) {
  const left = offset(new Date(run.startedAt).getTime())
  const right = offset(new Date(run.endedAt).getTime())
  return { left: `${left}%`, width: `${Math.max(right - left, 0.25)}%` }
}

/**
 * A colour from the bundle id. A fixed palette would be used up by the third
 * editor; this way every app gets its own hue and keeps it across days.
 * Muted saturation, so the band does not shout on the warm paper.
 */
function color(bundleId: string) {
  let hash = 0
  for (const ch of bundleId) hash = (hash * 31 + ch.codePointAt(0)!) % 360
  return `hsl(${hash} 42% 52%)`
}

const clock = (isoDate: string) =>
  new Date(isoDate).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })

const label = (run: Run) => {
  if (run.idle) return 'Leerlauf'
  if (run.redacted) return `${run.appName} (Titel nicht gespeichert)`
  return run.title || run.appName
}

/** Is anything being recorded at all? An empty day does not say. */
const stale = computed(() => {
  const last = data.value?.lastSampleAt
  if (!last) return true
  return Date.now() - new Date(last).getTime() > 10 * 60_000
})

async function load() {
  loading.value = true
  try {
    data.value = await api.get<Day>('/api/activity/day', { date: day.value })
  } finally {
    loading.value = false
  }
}

async function forget(run: Run) {
  if (!confirm(`${clock(run.startedAt)}–${clock(run.endedAt)} löschen?`)) return
  const range = `from=${encodeURIComponent(run.startedAt)}&to=${encodeURIComponent(run.endedAt)}`
  await api.del(`/api/activity?${range}`)
  await load()
}

watch(day, load)
onMounted(load)
</script>

<template>
  <section>
    <div class="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 class="eyebrow">Aktivität</h2>
        <p class="mt-1 text-xs text-muted">
          Stichproben vom Mac, alle {{ data?.sampleSeconds ?? 20 }} s. Bleiben
          {{ data?.retentionDays ?? 30 }} Tage liegen und verlassen diesen Rechner nicht.
        </p>
      </div>
      <input v-model="day" type="date" class="input w-auto" />
    </div>

    <p v-if="stale && !loading" class="mb-3 border-l-2 border-warn pl-3 text-xs text-warn">
      Seit über zehn Minuten kamen keine Stichproben. Läuft die macOS-App, und steht der Haken bei
      „Aktivität aufzeichnen"? Beim ersten Mal fragt macOS nach den Bedienungshilfen.
    </p>

    <div class="border-t-2 border-ink pt-3">
      <!-- The band itself: one stripe per segment, idle time only hinted at. -->
      <div class="relative h-9 bg-paper-2">
        <div
          v-for="run in visible"
          :key="run.startedAt"
          class="absolute top-0 h-full"
          :class="run.idle ? 'opacity-25' : ''"
          :style="{
            ...place(run),
            background: run.idle ? 'var(--color-line-strong)' : color(run.bundleId),
          }"
          :title="`${clock(run.startedAt)}–${clock(run.endedAt)} · ${label(run)}`"
        />
      </div>
      <div class="relative mt-1 h-4">
        <span
          v-for="h in hours"
          :key="h.at"
          class="absolute -translate-x-1/2 text-[10px] tabular-nums text-muted"
          :style="{ left: `${offset(h.at)}%` }"
        >
          {{ h.label }}
        </span>
      </div>
    </div>

    <div class="mt-4 grid gap-4 lg:grid-cols-[1fr_260px]">
      <div class="border-t border-line-strong">
        <table class="table">
          <thead>
            <tr>
              <th>Zeit</th>
              <th>App</th>
              <th>Fenster</th>
              <th class="text-right">Dauer</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="run in visible" :key="run.startedAt" class="hover:bg-ink/[0.035]">
              <td class="whitespace-nowrap text-xs tabular-nums text-muted">
                {{ clock(run.startedAt) }}–{{ clock(run.endedAt) }}
              </td>
              <td class="whitespace-nowrap">
                <span
                  v-if="!run.idle"
                  class="mr-2 inline-block h-2 w-2 align-middle"
                  :style="{ background: color(run.bundleId) }"
                />
                {{ run.idle ? '—' : run.appName }}
              </td>
              <td class="max-w-0 truncate text-soft">
                {{ label(run) }}
                <span v-if="run.titleCount > 1" class="text-xs text-muted">
                  +{{ run.titleCount - 1 }}
                </span>
              </td>
              <td class="text-right tabular-nums">{{ formatDuration(run.seconds) }}</td>
              <td class="text-right">
                <button class="text-xs text-bad hover:underline" @click="forget(run)">✕</button>
              </td>
            </tr>
            <tr v-if="!visible.length">
              <td colspan="5" class="py-8 text-center text-muted">
                {{ loading ? 'lädt …' : 'Für diesen Tag liegt nichts vor.' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3 class="eyebrow-muted mb-3">Nach App</h3>
        <div class="mb-3 flex items-baseline justify-between text-sm">
          <span>aktiv</span>
          <span class="tabular-nums">{{ formatDuration(data?.activeSeconds ?? 0) }} h</span>
        </div>
        <div class="mb-3 flex items-baseline justify-between text-sm text-muted">
          <span>Leerlauf</span>
          <span class="tabular-nums">{{ formatDuration(data?.idleSeconds ?? 0) }} h</span>
        </div>
        <ul class="space-y-1.5 border-t border-line pt-3 text-sm">
          <li
            v-for="app in data?.apps ?? []"
            :key="app.bundleId"
            class="flex items-baseline justify-between gap-2"
          >
            <span class="flex min-w-0 items-baseline gap-2">
              <span class="h-2 w-2 shrink-0" :style="{ background: color(app.bundleId) }" />
              <span class="truncate">{{ app.appName || app.bundleId || 'unbekannt' }}</span>
            </span>
            <span class="tabular-nums text-muted">{{ formatDuration(app.seconds) }}</span>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
