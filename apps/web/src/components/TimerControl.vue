<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useTimer } from '@/stores/timer'

/**
 * Die Stoppuhr.
 *
 * Vorher ließ sich ein Timer nur über eine kleine Schaltfläche in der
 * Projektzeile starten — auf der Zeiten-Seite selbst gab es keinen Startknopf,
 * nur "Nachtragen". Das hier ist der Platz, an dem man ihn sucht.
 */

type Project = { id: string; key: string; name: string; color?: string }
type RecentEntry = {
  projectId: string
  description: string
  project: { id: string; key: string; name: string }
}

const props = defineProps<{ projects: Project[]; recent?: RecentEntry[] }>()
const emit = defineEmits<{ changed: [] }>()

const timer = useTimer()
const projectId = ref('')
const description = ref('')
const billable = ref(true)
const busy = ref(false)
const error = ref('')

/** Beim Öffnen das zuletzt bebuchte Projekt vorwählen. */
watch(
  () => props.projects,
  (list) => {
    if (projectId.value || !list.length) return
    const last = timer.lastProjectId()
    projectId.value = list.some((p) => p.id === last) ? last! : (list[0]?.id ?? '')
  },
  { immediate: true },
)

/** Wiederaufnehmen: die zuletzt gebuchten Kombinationen, ohne Dubletten. */
const resumable = computed(() => {
  const seen = new Set<string>()
  const out: RecentEntry[] = []
  for (const e of props.recent ?? []) {
    const key = `${e.projectId}|${e.description}`
    if (seen.has(key) || !e.description) continue
    seen.add(key)
    out.push(e)
    if (out.length === 4) break
  }
  return out
})

async function start(withProject = projectId.value, withText = description.value) {
  if (!withProject) return
  busy.value = true
  error.value = ''
  try {
    await timer.start(withProject, withText, billable.value)
    description.value = ''
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function stop() {
  busy.value = true
  try {
    await timer.stop()
    emit('changed')
  } finally {
    busy.value = false
  }
}

async function discard() {
  if (!confirm('Laufenden Timer verwerfen? Der Eintrag wird gelöscht.')) return
  busy.value = true
  try {
    await timer.discard()
    emit('changed')
  } finally {
    busy.value = false
  }
}

/** Beschreibung während des Laufens nachtragen. */
const liveText = ref('')
watch(
  () => timer.running?.id,
  () => (liveText.value = timer.running?.description ?? ''),
  { immediate: true },
)
let saveHandle: ReturnType<typeof setTimeout> | null = null
function onLiveInput() {
  if (saveHandle) clearTimeout(saveHandle)
  saveHandle = setTimeout(() => timer.describe(liveText.value), 600)
}
</script>

<template>
  <!-- ===================================================================== -->
  <!-- Läuft                                                                  -->
  <!-- ===================================================================== -->
  <section v-if="timer.running" class="border-2 border-ink bg-acid">
    <div class="flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-4">
      <div class="flex items-baseline gap-3">
        <span class="relative flex h-2.5 w-2.5">
          <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-ink/40" />
          <span class="relative inline-flex h-2.5 w-2.5 rounded-full bg-ink" />
        </span>
        <span class="font-display text-5xl font-semibold leading-none tabular-nums">
          {{ timer.display }}
        </span>
      </div>

      <div class="min-w-0 flex-1">
        <div class="eyebrow-muted !text-ink/70">
          {{ timer.running.project.key }} · {{ timer.running.project.name }}
        </div>
        <input
          v-model="liveText"
          class="mt-1 w-full border-b border-ink/30 bg-transparent pb-1 text-sm text-ink outline-none placeholder:text-ink/40 focus:border-ink"
          placeholder="Woran arbeitest du gerade?"
          @input="onLiveInput"
        />
      </div>

      <div class="flex items-center gap-2">
        <button
          class="rounded-full border border-ink px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors hover:bg-ink/10"
          :disabled="busy"
          @click="discard"
        >
          Verwerfen
        </button>
        <button
          class="rounded-full bg-ink px-5 py-2 text-[11px] font-bold uppercase tracking-[0.09em] text-acid transition-opacity hover:opacity-85"
          :disabled="busy"
          @click="stop"
        >
          ■ Stopp
        </button>
      </div>
    </div>
  </section>

  <!-- ===================================================================== -->
  <!-- Bereit                                                                 -->
  <!-- ===================================================================== -->
  <section v-else class="border-2 border-ink bg-raised">
    <div v-if="!projects.length" class="flex flex-wrap items-center gap-3 px-5 py-4">
      <span class="eyebrow-muted">Stoppuhr</span>
      <p class="min-w-0 flex-1 text-sm text-muted">
        Zeiterfassung braucht ein Projekt — daran hängen Stundensatz und Rechnung.
      </p>
      <RouterLink to="/projects" class="btn-primary">
        <span>Projekt anlegen</span><span aria-hidden="true">↗</span>
      </RouterLink>
    </div>

    <form v-else class="flex flex-wrap items-end gap-3 px-5 py-4" @submit.prevent="start()">
      <div class="w-48">
        <label class="label">Projekt</label>
        <select v-model="projectId" class="input">
          <option v-for="p in projects" :key="p.id" :value="p.id">
            {{ p.key }} — {{ p.name }}
          </option>
        </select>
      </div>

      <div class="min-w-48 flex-1">
        <label class="label">Woran arbeitest du?</label>
        <input v-model="description" class="input" placeholder="optional" />
      </div>

      <label class="flex items-center gap-2 pb-2.5 text-sm">
        <input v-model="billable" type="checkbox" /> abrechenbar
      </label>

      <button class="btn-acid !px-6 !py-2.5" :disabled="busy || !projectId">
        <span class="text-base leading-none">▶</span>
        <span>{{ busy ? 'Startet …' : 'Start' }}</span>
      </button>
    </form>

    <!-- Zuletzt gebucht: ein Klick, weiterlaufen -->
    <div
      v-if="resumable.length"
      class="flex flex-wrap items-center gap-2 border-t border-line bg-shell/50 px-5 py-2.5"
    >
      <span class="eyebrow-muted mr-1">Weiter mit</span>
      <button
        v-for="entry in resumable"
        :key="entry.projectId + entry.description"
        class="btn-xs max-w-64"
        :title="`${entry.project.key}: ${entry.description}`"
        @click="start(entry.projectId, entry.description)"
      >
        <span class="shrink-0">▶ {{ entry.project.key }}</span>
        <span class="truncate normal-case tracking-normal">{{ entry.description }}</span>
      </button>
    </div>

    <p v-if="error" class="border-t border-bad/40 bg-bad/5 px-5 py-2 text-sm text-bad">
      {{ error }}
    </p>
  </section>
</template>
