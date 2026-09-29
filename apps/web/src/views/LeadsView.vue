<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

type Lead = {
  id: string
  title: string
  stage: string
  source: string
  company: string | null
  contactName: string | null
  probability: number
  aiScore: number | null
  expectedCloseOn: string | null
  computedValueCents: number
  weightedCents: number
  staleDays: number
  client: { id: string; name: string } | null
}

type StageSummary = {
  stage: string
  label: string
  count: number
  valueCents: number
  weightedCents: number
}

type Pipeline = {
  openCount: number
  openValueCents: number
  weightedCents: number
  byStage: StageSummary[]
  stale: { id: string; title: string; days: number }[]
  wonThisYear: number
  wonValueCents: number
  winRate: number | null
}

const STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION'] as const
const STAGE_LABEL: Record<string, string> = {
  NEW: 'Neu',
  QUALIFIED: 'Qualifiziert',
  PROPOSAL: 'Angebot',
  NEGOTIATION: 'Verhandlung',
  WON: 'Gewonnen',
  LOST: 'Verloren',
}
const SOURCE_LABEL: Record<string, string> = {
  REFERRAL: 'Empfehlung',
  WEBSITE: 'Website',
  OUTBOUND: 'Kaltakquise',
  NETWORK: 'Netzwerk',
  EVENT: 'Veranstaltung',
  OTHER: 'Sonstige',
}

const leads = ref<Lead[]>([])
const pipeline = ref<Pipeline | null>(null)
const showClosed = ref(false)
const showNew = ref(false)
const busy = ref(false)
const error = ref('')

const draft = ref({
  title: '',
  company: '',
  contactName: '',
  contactEmail: '',
  source: 'REFERRAL',
  valueEur: '',
  probability: 25,
})

const closed = computed(() => leads.value.filter((l) => l.stage === 'WON' || l.stage === 'LOST'))

function inStage(stage: string) {
  return leads.value.filter((l) => l.stage === stage)
}

/** After more than two weeks of silence the lead goes visually dull. */
function staleTone(days: number) {
  if (days >= 30) return 'text-bad'
  if (days >= 14) return 'text-warn'
  return 'text-muted'
}

async function load() {
  const [list, summary] = await Promise.all([
    api.get<Lead[]>('/api/leads'),
    api.get<Pipeline>('/api/leads/pipeline'),
  ])
  leads.value = list
  pipeline.value = summary
}

async function create() {
  if (!draft.value.title.trim()) return
  busy.value = true
  error.value = ''
  try {
    await api.post('/api/leads', {
      title: draft.value.title,
      company: draft.value.company || null,
      contactName: draft.value.contactName || null,
      contactEmail: draft.value.contactEmail || null,
      source: draft.value.source,
      valueCents: draft.value.valueEur ? Math.round(Number(draft.value.valueEur) * 100) : null,
      probability: draft.value.probability,
    })
    draft.value = {
      title: '',
      company: '',
      contactName: '',
      contactEmail: '',
      source: 'REFERRAL',
      valueEur: '',
      probability: 25,
    }
    showNew.value = false
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function move(lead: Lead, stage: string) {
  await api.post(`/api/leads/${lead.id}/stage`, { stage })
  await load()
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Vertrieb"
      title="Leads"
      subtitle="Was in Arbeit ist, was es wert ist und was davon realistisch kommt."
    >
      <template #actions>
        <button class="btn-primary" @click="showNew = !showNew">
          {{ showNew ? 'Abbrechen' : 'Neuer Lead' }}
        </button>
      </template>
    </PageHeader>

    <div v-if="pipeline" class="tile-grid mb-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Offene Chancen"
        :value="String(pipeline.openCount)"
        :hint="formatMoney(pipeline.openValueCents) + ' Volumen'"
      />
      <StatCard
        label="Gewichtet erwartet"
        :value="formatMoney(pipeline.weightedCents)"
        hint="Summe mal deiner Wahrscheinlichkeit"
        tone="good"
      />
      <StatCard
        label="Gewonnen dieses Jahr"
        :value="formatMoney(pipeline.wonValueCents)"
        :hint="pipeline.wonThisYear + ' Abschlüsse'"
      />
      <StatCard
        label="Trefferquote"
        :value="pipeline.winRate === null ? '—' : pipeline.winRate + ' %'"
        hint="nur entschiedene Leads"
        :tone="pipeline.winRate !== null && pipeline.winRate < 25 ? 'warn' : 'default'"
      />
    </div>

    <div v-if="pipeline?.stale.length" class="card mb-8 border-l-2 border-warn p-4">
      <div class="eyebrow-muted mb-2">Liegt zu lange still</div>
      <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <RouterLink
          v-for="s in pipeline.stale"
          :key="s.id"
          :to="`/leads/${s.id}`"
          class="hover:text-ink"
        >
          {{ s.title }}
          <span class="text-warn tabular-nums">· {{ s.days }} Tage</span>
        </RouterLink>
      </div>
    </div>

    <form v-if="showNew" class="card mb-8 space-y-4 p-5" @submit.prevent="create">
      <div class="grid gap-4 sm:grid-cols-2">
        <label class="label sm:col-span-2">
          Worum geht es
          <input v-model="draft.title" class="input" placeholder="DWH-Ablösung Beispiel GmbH" />
        </label>
        <label class="label">
          Firma
          <input v-model="draft.company" class="input" />
        </label>
        <label class="label">
          Kontakt
          <input v-model="draft.contactName" class="input" />
        </label>
        <label class="label">
          E-Mail
          <input v-model="draft.contactEmail" type="email" class="input" />
          <span class="mt-1 block text-xs text-muted">
            Mails von dieser Adresse landen automatisch am Lead.
          </span>
        </label>
        <label class="label">
          Quelle
          <select v-model="draft.source" class="input">
            <option v-for="(label, key) in SOURCE_LABEL" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
        </label>
        <label class="label">
          Erwarteter Wert (€)
          <input v-model="draft.valueEur" type="number" min="0" step="100" class="input" />
        </label>
        <label class="label">
          Wahrscheinlichkeit: {{ draft.probability }} %
          <input v-model.number="draft.probability" type="range" min="0" max="100" step="5" />
        </label>
      </div>
      <p v-if="error" class="text-sm text-bad">{{ error }}</p>
      <button class="btn-primary" :disabled="busy">Anlegen</button>
    </form>

    <!-- Pipeline: one column per stage, stacked when space runs short. -->
    <div class="grid gap-5 lg:grid-cols-4">
      <section v-for="stage in STAGES" :key="stage" class="min-w-0">
        <header class="mb-3 flex items-baseline justify-between border-t-2 border-ink pt-2">
          <span class="eyebrow-muted">{{ STAGE_LABEL[stage] }}</span>
          <span class="font-display text-sm tabular-nums text-muted">
            {{ inStage(stage).length }}
          </span>
        </header>

        <div class="space-y-3">
          <article v-for="lead in inStage(stage)" :key="lead.id" class="card p-3.5">
            <RouterLink :to="`/leads/${lead.id}`" class="block hover:text-ink">
              <div class="font-display text-sm font-semibold leading-snug">{{ lead.title }}</div>
              <div v-if="lead.company || lead.client" class="mt-0.5 text-xs text-muted">
                {{ lead.client?.name ?? lead.company }}
              </div>
            </RouterLink>

            <div class="mt-3 flex items-baseline justify-between">
              <span class="font-display text-base font-semibold tabular-nums">
                {{ formatMoney(lead.computedValueCents) }}
              </span>
              <span class="text-xs tabular-nums text-muted">{{ lead.probability }} %</span>
            </div>

            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <span
                v-if="lead.aiScore !== null"
                class="badge"
                :class="lead.aiScore >= 60 ? 'badge-good' : lead.aiScore >= 30 ? '' : 'badge-warn'"
                :title="'AI-Einschätzung: ' + lead.aiScore + ' %'"
              >
                AI {{ lead.aiScore }}
              </span>
              <span class="text-xs tabular-nums" :class="staleTone(lead.staleDays)">
                {{ lead.staleDays === 0 ? 'heute' : lead.staleDays + ' T' }}
              </span>
            </div>

            <div class="mt-3 flex gap-1 border-t border-line pt-2.5">
              <button
                v-for="target in STAGES.filter((s) => s !== stage)"
                :key="target"
                class="btn-xs"
                :title="'Nach ' + STAGE_LABEL[target]"
                @click="move(lead, target)"
              >
                {{ STAGE_LABEL[target].slice(0, 3) }}
              </button>
              <button class="btn-xs ml-auto" title="Gewonnen" @click="move(lead, 'WON')">✓</button>
              <button class="btn-xs" title="Verloren" @click="move(lead, 'LOST')">✕</button>
            </div>
          </article>

          <p v-if="!inStage(stage).length" class="py-3 text-xs text-muted">nichts</p>
        </div>
      </section>
    </div>

    <section v-if="closed.length" class="mt-10">
      <button class="eyebrow mb-3" @click="showClosed = !showClosed">
        {{ showClosed ? '▾' : '▸' }} Entschieden ({{ closed.length }})
      </button>
      <table v-if="showClosed" class="table">
        <thead>
          <tr>
            <th>Lead</th>
            <th>Ausgang</th>
            <th class="text-right">Wert</th>
            <th>Quelle</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="lead in closed" :key="lead.id">
            <td>
              <RouterLink :to="`/leads/${lead.id}`" class="hover:text-ink">
                {{ lead.title }}
              </RouterLink>
            </td>
            <td>
              <span class="badge" :class="lead.stage === 'WON' ? 'badge-good' : 'badge-bad'">
                {{ STAGE_LABEL[lead.stage] }}
              </span>
            </td>
            <td class="text-right tabular-nums">{{ formatMoney(lead.computedValueCents) }}</td>
            <td class="text-muted">{{ SOURCE_LABEL[lead.source] }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
