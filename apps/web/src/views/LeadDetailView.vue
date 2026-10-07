<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '@/api'
import { formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'

type Offer = {
  id: string
  title: string
  status: string
  amountCents: number
  currency: string
  scope: string | null
  sentOn: string | null
  validUntil: string | null
  decidedOn: string | null
  notes: string | null
}
type Activity = { id: string; kind: string; body: string; occurredAt: string; source: string }
type Mail = { id: string; subject: string; fromEmail: string; sentAt: string; snippet: string }
type Lead = {
  id: string
  title: string
  stage: string
  source: string
  company: string | null
  contactName: string | null
  contactEmail: string | null
  phone: string | null
  valueCents: number | null
  probability: number
  expectedCloseOn: string | null
  notes: string | null
  lostReason: string | null
  aiScore: number | null
  aiScoreReason: string | null
  aiNextStep: string | null
  aiScoredAt: string | null
  computedValueCents: number
  weightedCents: number
  staleDays: number
  followUpOn: string | null
  followUpNote: string | null
  followUpDays: number | null
  offers: Offer[]
  activities: Activity[]
  mails: Mail[]
  client: { id: string; name: string } | null
}

const STAGES = ['NEW', 'QUALIFIED', 'PROPOSAL', 'NEGOTIATION', 'WON', 'LOST']
const STAGE_LABEL: Record<string, string> = {
  NEW: 'Neu',
  QUALIFIED: 'Qualifiziert',
  PROPOSAL: 'Angebot',
  NEGOTIATION: 'Verhandlung',
  WON: 'Gewonnen',
  LOST: 'Verloren',
}
const OFFER_LABEL: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'verschickt',
  ACCEPTED: 'angenommen',
  REJECTED: 'abgelehnt',
  EXPIRED: 'abgelaufen',
}
const KIND_LABEL: Record<string, string> = {
  NOTE: 'Notiz',
  CALL: 'Anruf',
  MAIL: 'Mail',
  MEETING: 'Meeting',
  OFFER: 'Angebot',
  STAGE_CHANGE: 'Stufe',
  FOLLOW_UP: 'Nachfass',
}

const route = useRoute()
const router = useRouter()
const lead = ref<Lead | null>(null)
const error = ref('')
const scoring = ref(false)
const showOffer = ref(false)

const note = ref({ kind: 'NOTE', body: '' })
const offer = ref({
  title: '',
  amountEur: '',
  scope: '',
  status: 'SENT',
  sentOn: new Date().toISOString().slice(0, 10),
  validUntil: '',
})

const followUpDraft = ref({ on: '', note: '' })
const doneNote = ref('')

/** How urgent the follow-up reads: overdue, today, or still ahead. */
const followUpTone = computed(() => {
  const days = lead.value?.followUpDays
  if (days === null || days === undefined) return ''
  if (days < 0) return 'text-bad'
  if (days === 0) return 'text-warn'
  return 'text-muted'
})

const followUpWhen = computed(() => {
  const days = lead.value?.followUpDays
  if (days === null || days === undefined) return ''
  if (days < 0) return `${-days} Tag(e) überfällig`
  if (days === 0) return 'heute fällig'
  if (days === 1) return 'morgen'
  return `in ${days} Tagen`
})

/** Where a postponement starts counting: today, or a date still ahead. */
function snoozeBase(): Date {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  if (!lead.value?.followUpOn) return today
  const current = new Date(lead.value.followUpOn)
  current.setHours(12, 0, 0, 0)
  return current > today ? current : today
}

/** Where the AI and your own estimate diverge, that gap is the message. */
const scoreGap = computed(() => {
  if (!lead.value || lead.value.aiScore === null) return null
  return lead.value.aiScore - lead.value.probability
})

const date = (v: string | null) => (v ? new Date(v).toLocaleDateString('de-DE') : '—')

async function load() {
  lead.value = await api.get<Lead>(`/api/leads/${route.params.id}`)
}

async function patch(data: Record<string, unknown>) {
  await api.patch(`/api/leads/${route.params.id}`, data)
  await load()
}

async function setStage(stage: string) {
  await api.post(`/api/leads/${route.params.id}/stage`, { stage })
  await load()
}

async function addNote() {
  if (!note.value.body.trim()) return
  await api.post(`/api/leads/${route.params.id}/activities`, note.value)
  note.value = { kind: 'NOTE', body: '' }
  await load()
}

async function addOffer() {
  if (!offer.value.title.trim() || !offer.value.amountEur) return
  await api.post(`/api/leads/${route.params.id}/offers`, {
    title: offer.value.title,
    amountCents: Math.round(Number(offer.value.amountEur) * 100),
    scope: offer.value.scope || null,
    status: offer.value.status,
    sentOn: offer.value.sentOn || null,
    validUntil: offer.value.validUntil || null,
  })
  offer.value = {
    title: '',
    amountEur: '',
    scope: '',
    status: 'SENT',
    sentOn: new Date().toISOString().slice(0, 10),
    validUntil: '',
  }
  showOffer.value = false
  await load()
}

async function decideOffer(id: string, status: string) {
  await api.patch(`/api/leads/${route.params.id}/offers/${id}`, { status })
  await load()
}

async function putOnFollowUp() {
  if (!followUpDraft.value.on) return
  await api.post(`/api/leads/${route.params.id}/follow-up`, {
    on: followUpDraft.value.on,
    note: followUpDraft.value.note || null,
  })
  followUpDraft.value = { on: '', note: '' }
  await load()
}

async function snooze(days: number) {
  const target = snoozeBase()
  target.setDate(target.getDate() + days)
  await api.post(`/api/leads/${route.params.id}/follow-up`, {
    on: target.toISOString().slice(0, 10),
    note: lead.value?.followUpNote ?? null,
  })
  await load()
}

async function finishFollowUp() {
  await api.post(`/api/leads/${route.params.id}/follow-up/done`, {
    note: doneNote.value || undefined,
  })
  doneNote.value = ''
  await load()
}

async function dropFollowUp() {
  await api.del(`/api/leads/${route.params.id}/follow-up`)
  await load()
}

async function score() {
  scoring.value = true
  error.value = ''
  try {
    await api.post(`/api/leads/${route.params.id}/score`, {})
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    scoring.value = false
  }
}

async function archive() {
  await api.del(`/api/leads/${route.params.id}`)
  router.push('/leads')
}

onMounted(load)
</script>

<template>
  <div v-if="lead">
    <PageHeader
      eyebrow="Lead"
      :title="lead.title"
      :subtitle="
        [lead.client?.name ?? lead.company, lead.contactName, lead.contactEmail]
          .filter(Boolean)
          .join(' · ')
      "
    >
      <template #actions>
        <button class="btn-ghost" :disabled="scoring" @click="score">
          {{ scoring ? 'bewertet …' : 'AI-Bewertung' }}
        </button>
        <button class="btn-ghost" @click="archive">Archivieren</button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-6 text-sm text-bad">{{ error }}</p>

    <!-- The stage bar: state is the most important thing on this page. -->
    <div class="mb-8 flex flex-wrap gap-1.5">
      <button
        v-for="s in STAGES"
        :key="s"
        class="btn-xs"
        :class="s === lead.stage ? 'btn-primary' : ''"
        @click="setStage(s)"
      >
        {{ STAGE_LABEL[s] }}
      </button>
    </div>

    <!-- Follow-up: the one thing that has to catch the eye on this page. -->
    <section
      class="card mb-8 p-4"
      :class="lead.followUpDays !== null && lead.followUpDays <= 0 ? 'border-l-2 border-bad' : ''"
    >
      <div class="eyebrow-muted mb-2">Wiedervorlage</div>

      <template v-if="lead.followUpOn">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span class="font-display text-base font-semibold tabular-nums">
            {{ date(lead.followUpOn) }}
          </span>
          <span class="text-sm" :class="followUpTone">{{ followUpWhen }}</span>
        </div>
        <p v-if="lead.followUpNote" class="mt-1 text-sm">{{ lead.followUpNote }}</p>

        <div class="mt-3 flex flex-wrap items-center gap-1.5">
          <input
            v-model="doneNote"
            class="input w-auto flex-1 py-1 text-xs"
            placeholder="Was kam dabei heraus? (optional)"
            @keyup.enter="finishFollowUp()"
          />
          <button class="btn-xs btn-primary" @click="finishFollowUp()">Nachgefasst</button>
          <button class="btn-xs" @click="snooze(1)">+1 Tag</button>
          <button class="btn-xs" @click="snooze(3)">+3 Tage</button>
          <button class="btn-xs" @click="snooze(7)">+1 Woche</button>
          <button class="btn-xs" title="Ohne Verlaufseintrag entfernen" @click="dropFollowUp()">
            Entfernen
          </button>
        </div>
        <p class="mt-2 text-xs text-muted">
          „Nachgefasst" schreibt den Punkt in den Verlauf und zählt als Kontakt. Die App meldet eine
          fällige Wiedervorlage einmal als Mitteilung.
        </p>
      </template>

      <form v-else class="flex flex-wrap items-center gap-1.5" @submit.prevent="putOnFollowUp">
        <input v-model="followUpDraft.on" type="date" class="input w-auto py-1 text-xs" />
        <input
          v-model="followUpDraft.note"
          class="input w-auto flex-1 py-1 text-xs"
          placeholder="Worum geht es? z.B. Angebot nachfassen"
        />
        <button class="btn-xs btn-primary">Auf Wiedervorlage</button>
      </form>
    </section>

    <div class="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <div class="min-w-0 space-y-8">
        <!-- Offers -->
        <section>
          <div class="mb-3 flex items-baseline justify-between border-b border-line-strong pb-2">
            <h2 class="eyebrow">Angebote</h2>
            <button class="btn-xs" @click="showOffer = !showOffer">
              {{ showOffer ? 'Abbrechen' : 'Angebot erfassen' }}
            </button>
          </div>

          <form v-if="showOffer" class="card mb-4 space-y-3 p-4" @submit.prevent="addOffer">
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="label sm:col-span-2">
                Titel
                <input v-model="offer.title" class="input" placeholder="Migration Phase 1" />
              </label>
              <label class="label">
                Summe (€, netto)
                <input v-model="offer.amountEur" type="number" min="0" step="100" class="input" />
              </label>
              <label class="label">
                Status
                <select v-model="offer.status" class="input">
                  <option v-for="(l, k) in OFFER_LABEL" :key="k" :value="k">{{ l }}</option>
                </select>
              </label>
              <label class="label">
                Verschickt am
                <input v-model="offer.sentOn" type="date" class="input" />
              </label>
              <label class="label">
                Gültig bis
                <input v-model="offer.validUntil" type="date" class="input" />
              </label>
              <label class="label sm:col-span-2">
                Umfang
                <textarea v-model="offer.scope" rows="2" class="input"></textarea>
              </label>
            </div>
            <button class="btn-primary">Speichern</button>
          </form>

          <table v-if="lead.offers.length" class="table">
            <thead>
              <tr>
                <th>Angebot</th>
                <th class="text-right">Summe</th>
                <th>Status</th>
                <th>Verschickt</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in lead.offers" :key="o.id">
                <td>
                  <div class="font-medium">{{ o.title }}</div>
                  <div v-if="o.scope" class="text-xs text-muted">{{ o.scope }}</div>
                </td>
                <td class="text-right font-display tabular-nums">
                  {{ formatMoney(o.amountCents, o.currency) }}
                </td>
                <td>
                  <span
                    class="badge"
                    :class="{
                      'badge-good': o.status === 'ACCEPTED',
                      'badge-bad': o.status === 'REJECTED',
                      'badge-blue': o.status === 'SENT',
                    }"
                  >
                    {{ OFFER_LABEL[o.status] }}
                  </span>
                </td>
                <td class="tabular-nums text-muted">{{ date(o.sentOn) }}</td>
                <td class="text-right">
                  <template v-if="o.status === 'SENT'">
                    <button class="btn-xs" @click="decideOffer(o.id, 'ACCEPTED')">✓</button>
                    <button class="btn-xs" @click="decideOffer(o.id, 'REJECTED')">✕</button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="text-sm text-muted">Noch nichts angeboten.</p>
        </section>

        <!-- History -->
        <section>
          <h2 class="eyebrow mb-3 border-b border-line-strong pb-2">Verlauf</h2>

          <form class="mb-5 flex flex-wrap gap-2" @submit.prevent="addNote">
            <select v-model="note.kind" class="input w-auto">
              <option value="NOTE">Notiz</option>
              <option value="CALL">Anruf</option>
              <option value="MAIL">Mail</option>
              <option value="MEETING">Meeting</option>
            </select>
            <input
              v-model="note.body"
              class="input min-w-0 flex-1"
              placeholder="Was ist passiert?"
            />
            <button class="btn-primary">Eintragen</button>
          </form>

          <ol class="space-y-0">
            <li
              v-for="a in lead.activities"
              :key="a.id"
              class="flex gap-4 border-b border-line py-2.5 text-sm last:border-0"
            >
              <span class="w-20 shrink-0 tabular-nums text-muted">{{ date(a.occurredAt) }}</span>
              <span class="w-16 shrink-0 text-xs text-blue">{{ KIND_LABEL[a.kind] }}</span>
              <span class="min-w-0 flex-1">{{ a.body }}</span>
            </li>
          </ol>
        </section>

        <!-- Mail -->
        <section v-if="lead.mails.length">
          <h2 class="eyebrow mb-3 border-b border-line-strong pb-2">
            Zugeordnete Mails ({{ lead.mails.length }})
          </h2>
          <ol class="space-y-0">
            <li
              v-for="m in lead.mails"
              :key="m.id"
              class="border-b border-line py-2.5 last:border-0"
            >
              <div class="flex items-baseline gap-3 text-sm">
                <span class="w-20 shrink-0 tabular-nums text-muted">{{ date(m.sentAt) }}</span>
                <span class="font-medium">{{ m.subject }}</span>
              </div>
              <div class="ml-[5.75rem] mt-0.5 text-xs text-muted">
                {{ m.fromEmail }} — {{ m.snippet }}
              </div>
            </li>
          </ol>
        </section>
      </div>

      <!-- Side column: the numbers and the AI's take -->
      <aside class="space-y-6">
        <div class="card p-4">
          <div class="eyebrow-muted mb-3">Bewertung</div>

          <div class="border-t-2 border-ink pt-2">
            <div class="text-xs text-muted">Wert</div>
            <div class="font-display text-2xl font-semibold tabular-nums">
              {{ formatMoney(lead.computedValueCents) }}
            </div>
            <div v-if="lead.offers.length" class="mt-0.5 text-xs text-muted">
              aus dem Angebot, nicht der Schätzung
            </div>
          </div>

          <label class="label mt-4 block">
            Deine Wahrscheinlichkeit: {{ lead.probability }} %
            <input
              type="range"
              min="0"
              max="100"
              step="5"
              :value="lead.probability"
              @change="patch({ probability: Number(($event.target as HTMLInputElement).value) })"
            />
          </label>

          <div class="mt-2 flex items-baseline justify-between text-sm">
            <span class="text-muted">gewichtet</span>
            <span class="font-display tabular-nums">{{ formatMoney(lead.weightedCents) }}</span>
          </div>

          <div class="mt-4 flex items-baseline justify-between text-sm">
            <span class="text-muted">letzte Aktivität</span>
            <span class="tabular-nums" :class="lead.staleDays >= 14 ? 'text-warn' : ''">
              vor {{ lead.staleDays }} Tagen
            </span>
          </div>
        </div>

        <div v-if="lead.aiScore !== null" class="card p-4">
          <div class="eyebrow-muted mb-3">AI-Einschätzung</div>
          <div class="flex items-baseline gap-3">
            <span class="font-display text-3xl font-semibold tabular-nums">
              {{ lead.aiScore }}
            </span>
            <span
              v-if="scoreGap !== null && Math.abs(scoreGap) >= 15"
              class="badge"
              :class="scoreGap > 0 ? 'badge-good' : 'badge-warn'"
            >
              {{ scoreGap > 0 ? '+' : '' }}{{ scoreGap }} ggü. dir
            </span>
          </div>
          <!-- Plain text rather than Markdown on purpose: the rationale is
               derived from foreign mail. Rendered HTML would be a way to get
               script into the interface through a crafted message. -->
          <p v-if="lead.aiScoreReason" class="mt-3 whitespace-pre-line text-sm">
            {{ lead.aiScoreReason }}
          </p>
          <div v-if="lead.aiNextStep" class="mt-4 border-t border-line pt-3">
            <div class="eyebrow-muted mb-1">Nächster Schritt</div>
            <p class="text-sm">{{ lead.aiNextStep }}</p>
          </div>
          <div class="mt-3 text-xs text-muted">Stand {{ date(lead.aiScoredAt) }}</div>
        </div>

        <div class="card space-y-3 p-4">
          <div class="eyebrow-muted">Eckdaten</div>
          <label class="label">
            Erwarteter Abschluss
            <input
              type="date"
              class="input"
              :value="lead.expectedCloseOn?.slice(0, 10) ?? ''"
              @change="
                patch({ expectedCloseOn: ($event.target as HTMLInputElement).value || null })
              "
            />
          </label>
          <label class="label">
            E-Mail des Kontakts
            <input
              type="email"
              class="input"
              :value="lead.contactEmail ?? ''"
              @change="patch({ contactEmail: ($event.target as HTMLInputElement).value })"
            />
          </label>
          <label class="label">
            Notizen
            <textarea
              rows="4"
              class="input"
              :value="lead.notes ?? ''"
              @change="patch({ notes: ($event.target as HTMLTextAreaElement).value })"
            ></textarea>
          </label>
          <label v-if="lead.stage === 'LOST'" class="label">
            Warum verloren
            <input
              class="input"
              :value="lead.lostReason ?? ''"
              @change="patch({ lostReason: ($event.target as HTMLInputElement).value })"
            />
          </label>
        </div>
      </aside>
    </div>
  </div>
</template>
