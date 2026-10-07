<script setup lang="ts">
/**
 * The flow list and the monitoring, in one place.
 *
 * Deliberately not two tabs. The question "is everything running" and the
 * question "which automations do I have" have the same answer surface — a
 * flow with a red strip behind it is both the list entry and the alert.
 */
import { computed, ref } from 'vue'
import { api } from '@/api'
import {
  HEALTH_LABEL,
  HEALTH_TONE,
  RUN_BLOCK,
  RUN_LABEL,
  RUN_TONE,
  duration,
  when,
  type AutomationFlow,
  type AutomationRun,
} from '@/lib/automations'

const props = defineProps<{
  flows: AutomationFlow[]
  projects: { id: string; key: string }[]
  authorized: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const busy = ref('')
const error = ref('')

/** Failing first — the list should open on whatever needs attention. */
const ordered = computed(() =>
  [...props.flows].sort((a, b) => {
    const rank = { failing: 0, missing: 1, ok: 2, idle: 3 }
    return rank[a.health] - rank[b.health] || a.name.localeCompare(b.name)
  }),
)

const failing = computed(() => props.flows.filter((f) => f.health === 'failing'))

/** The newest failure of a flow, which is what the row should name. */
function lastError(flow: AutomationFlow): AutomationRun | undefined {
  return flow.runs.find((r) => r.status === 'ERROR')
}

async function act(id: string, fn: () => Promise<unknown>) {
  busy.value = id
  error.value = ''
  try {
    await fn()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

const toggle = (flow: AutomationFlow) =>
  act(flow.id, () => api.post(`/api/automations/flows/${flow.id}/active`, { active: !flow.active }))

const assign = (flow: AutomationFlow, projectId: string) =>
  act(flow.id, () =>
    api.patch(`/api/automations/flows/${flow.id}`, { projectId: projectId || null }),
  )

const remove = (flow: AutomationFlow) =>
  act(flow.id, () => api.del(`/api/automations/flows/${flow.id}`))
</script>

<template>
  <div>
    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>

    <!-- The one line worth reading first -->
    <div
      v-if="failing.length"
      class="mb-5 border-l-2 border-bad bg-bad/5 px-4 py-3 text-sm text-bad"
    >
      {{ failing.length }} Automatisierung{{ failing.length === 1 ? '' : 'en' }} scheitert gerade:
      {{ failing.map((f) => f.name).join(', ') }}
    </div>

    <div class="space-y-3">
      <div v-for="flow in ordered" :key="flow.id" class="card">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <a
                :href="flow.editorUrl"
                target="_blank"
                rel="noopener"
                class="font-display text-base font-semibold hover:underline"
              >
                {{ flow.name }}
              </a>
              <span class="badge" :class="HEALTH_TONE[flow.health]">
                {{ HEALTH_LABEL[flow.health] }}
              </span>
              <span v-if="flow.active" class="badge badge-acid">aktiv</span>
              <span v-else class="badge bg-paper-2 text-muted">inaktiv</span>
              <span v-if="flow.project" class="badge bg-paper-2 text-soft">
                {{ flow.project.key }}
              </span>
            </div>

            <!-- What sets it off, on the soloops side -->
            <p v-if="flow.triggers.length" class="mt-1.5 text-xs text-muted">
              hört auf
              {{ flow.triggers.map((t) => t.event.toLowerCase().replace(/_/g, '.')).join(', ') }}
            </p>
            <p v-else-if="!flow.missingSince" class="mt-1.5 text-xs text-muted">
              kein soloops-Trigger — läuft per Zeitplan oder fremdem Webhook
            </p>
          </div>

          <div class="flex shrink-0 items-center gap-2">
            <select
              class="input py-1 text-xs"
              :value="flow.projectId ?? ''"
              :disabled="busy === flow.id"
              @change="assign(flow, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">Projekt —</option>
              <option v-for="p in props.projects" :key="p.id" :value="p.id">{{ p.key }}</option>
            </select>
            <button
              v-if="!flow.missingSince"
              class="btn-ghost btn-xs"
              :disabled="busy === flow.id || !props.authorized"
              @click="toggle(flow)"
            >
              {{ flow.active ? 'Aus' : 'An' }}
            </button>
            <button class="btn-danger btn-xs" :disabled="busy === flow.id" @click="remove(flow)">
              Löschen
            </button>
          </div>
        </div>

        <!-- The run strip: newest on the right, so it reads like a timeline -->
        <div class="mt-3 flex items-center gap-3">
          <div class="flex gap-0.5" :title="`${flow.runCount} Läufe, ${flow.errorCount} Fehler`">
            <span
              v-for="run in [...flow.runs].reverse()"
              :key="run.id"
              class="h-4 w-2"
              :class="RUN_BLOCK[run.status]"
              :title="`${RUN_LABEL[run.status]} · ${when(run.startedAt)} · ${duration(run.durationMs)}${run.error ? ` · ${run.error}` : ''}`"
            />
            <span v-if="!flow.runs.length" class="text-xs text-muted">noch keine Läufe</span>
          </div>
          <span v-if="flow.lastStatus" class="badge" :class="RUN_TONE[flow.lastStatus]">
            {{ RUN_LABEL[flow.lastStatus] }}
          </span>
          <span class="ml-auto text-xs text-muted">{{ when(flow.lastRunAt) }}</span>
        </div>

        <!-- The failure itself, not just that there was one -->
        <p v-if="lastError(flow) && flow.failStreak" class="mt-2 text-xs text-bad">
          {{ lastError(flow)?.error ?? 'Lauf fehlgeschlagen, keine Meldung von n8n' }}
          <span class="text-muted">
            ({{ flow.failStreak }}× hintereinander, letzter
            {{ when(lastError(flow)?.startedAt ?? null) }})
          </span>
        </p>
        <p v-if="flow.missingSince" class="mt-2 text-xs text-warn">
          In n8n gelöscht seit {{ when(flow.missingSince) }}. Verlauf und Projektzuordnung bleiben
          hier, bis du die Zeile löschst.
        </p>
      </div>

      <p v-if="!props.flows.length" class="py-10 text-center text-sm text-muted">
        <template v-if="!props.authorized">
          Noch kein n8n-API-Key hinterlegt — ohne ihn kann soloops keine Flows lesen. Siehe
          „Verbindungen“.
        </template>
        <template v-else>
          Noch keine Flows. Bau einen im Builder oder nimm eine Vorlage als Startpunkt.
        </template>
      </p>
    </div>
  </div>
</template>
