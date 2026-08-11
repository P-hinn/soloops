<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api'
import { useAuth } from '@/stores/auth'
import { useTimer } from '@/stores/timer'

/**
 * Ein Feld für alles. Der Satz geht an die KI, die daraus einen Plan macht;
 * angelegt wird erst nach Bestätigung — und der Plan ist vorher editierbar,
 * weil "Dienstag 10 Uhr" öfter danebenliegt als man denkt.
 */

type EntityRef = {
  action: 'use' | 'create' | 'none'
  id: string | null
  name: string | null
  company?: string | null
  email?: string | null
  key?: string | null
  description?: string | null
}

type Plan = {
  understood: string
  confidence: 'high' | 'medium' | 'low'
  questions: string[]
  client: EntityRef
  project: EntityRef
  event: {
    create: boolean
    title: string | null
    startsAt: string | null
    endsAt: string | null
    kind: 'FOCUS' | 'MEETING' | 'ADMIN' | 'PERSONAL' | 'TRAVEL'
    location: string | null
    withVideo: boolean
  }
  meeting: { create: boolean; title: string | null; participants: string[]; agenda: string | null }
  note: { create: boolean; title: string | null; body: string | null; tags: string[] }
  actionItems: { title: string; dueOn: string | null }[]
  timer: { start: boolean; description: string | null }
}

type Applied = {
  links: { label: string; url: string }[]
  videoUrl?: string
}

const emit = defineEmits<{ created: [] }>()

const auth = useAuth()
const timer = useTimer()
const router = useRouter()

const text = ref('')
const plan = ref<Plan | null>(null)
const applied = ref<Applied | null>(null)
const busy = ref(false)
const error = ref('')

/** Beispiele, die zeigen was geht — Klick füllt das Feld, sendet aber nicht. */
const examples = [
  'Termin für neues Projekt mit Beispiel GmbH nächste Woche',
  'Kickoff-Meeting mit Video Donnerstag 10 Uhr',
  'Morgen 2 Stunden Fokuszeit für Konzeption',
  'Notiz: Kunde will CDC statt Nightly Load',
]

const aiReady = computed(() => auth.config?.features.ai === true)

const placeholder = computed(() =>
  aiReady.value
    ? 'Was soll passieren? z.B. „Termin für neues Projekt mit Beispiel GmbH nächste Woche“'
    : 'ANTHROPIC_API_KEY in der .env setzen, um das Feld zu nutzen',
)

async function askPlan() {
  if (!text.value.trim()) return
  busy.value = true
  error.value = ''
  applied.value = null
  plan.value = null
  try {
    plan.value = await api.post<Plan>('/api/assistant/plan', { text: text.value })
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function apply() {
  if (!plan.value) return
  busy.value = true
  error.value = ''
  try {
    applied.value = await api.post<Applied>('/api/assistant/apply', plan.value)
    plan.value = null
    text.value = ''
    await timer.refresh()
    emit('created')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function discard() {
  plan.value = null
  error.value = ''
}

/** Für die Datetime-Felder im Plan: ISO <-> Wert des Inputs. */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

const confidenceTone: Record<string, string> = {
  high: 'badge-good',
  medium: 'badge-warn',
  low: 'badge-bad',
}

/** Was der Plan konkret anlegen wird — als Liste, damit man es überblickt. */
const willCreate = computed(() => {
  const p = plan.value
  if (!p) return []
  const out: string[] = []
  if (p.client.action === 'create') out.push(`Kunde „${p.client.name}"`)
  if (p.client.action === 'use') out.push(`Kunde ${p.client.name} (bestehend)`)
  if (p.project.action === 'create') out.push(`Projekt ${p.project.key} — ${p.project.name}`)
  if (p.project.action === 'use') out.push(`Projekt ${p.project.name} (bestehend)`)
  if (p.event.create) out.push(p.event.withVideo ? 'Termin mit Videoraum' : 'Termin')
  if (p.meeting.create) out.push('Meeting')
  if (p.note.create) out.push(`Notiz „${p.note.title}"`)
  if (p.actionItems.length) out.push(`${p.actionItems.length} offene(r) Punkt(e)`)
  if (p.timer.start) out.push('Timer starten')
  return out
})
</script>

<template>
  <section class="border-2 border-ink">
    <!-- Eingabe -->
    <form class="flex items-stretch gap-0 border-b border-line" @submit.prevent="askPlan">
      <span class="flex items-center pl-4 pr-2 font-display text-lg text-blue">✳</span>
      <input
        v-model="text"
        class="flex-1 bg-transparent py-4 text-base text-ink outline-none placeholder:text-muted/70"
        :placeholder="placeholder"
        :disabled="!aiReady || busy"
      />
      <button class="btn-primary m-2" :disabled="!aiReady || busy || !text.trim()">
        <span>{{ busy && !plan ? 'Denkt …' : 'Planen' }}</span>
        <span aria-hidden="true">↗</span>
      </button>
    </form>

    <!-- Schnellaktionen -->
    <div class="flex flex-wrap items-center gap-2 px-4 py-3">
      <span class="eyebrow-muted mr-1">Schnell</span>
      <button
        v-if="timer.running"
        class="btn-xs !border-ink !bg-acid !text-ink"
        @click="timer.stop().then(() => emit('created'))"
      >
        ■ Timer stoppen · {{ timer.display }}
      </button>
      <button class="btn-xs" @click="router.push('/projects')">▶ Timer starten</button>
      <button class="btn-xs" @click="router.push('/meetings')">+ Meeting</button>
      <button class="btn-xs" @click="router.push('/calendar')">+ Termin</button>
      <button class="btn-xs" @click="router.push('/notes')">+ Notiz</button>
      <button class="btn-xs" @click="router.push('/invoices')">€ Abrechnen</button>

      <span class="ml-auto hidden gap-1 lg:flex">
        <button
          v-for="ex in examples"
          :key="ex"
          class="max-w-56 truncate text-left text-[11px] text-muted underline decoration-line underline-offset-2 hover:text-blue"
          :title="ex"
          @click="text = ex"
        >
          {{ ex }}
        </button>
      </span>
    </div>

    <!-- Fehler -->
    <p v-if="error" class="border-t border-bad/40 bg-bad/5 px-4 py-2.5 text-sm text-bad">
      {{ error }}
    </p>

    <!-- Ergebnis -->
    <div v-if="applied" class="border-t border-ink bg-acid px-4 py-3">
      <div class="flex flex-wrap items-center gap-3">
        <span class="eyebrow-muted !text-ink">Angelegt</span>
        <RouterLink
          v-for="link in applied.links"
          :key="link.url + link.label"
          :to="link.url"
          class="border border-ink px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] hover:bg-ink hover:text-acid"
        >
          {{ link.label }} ↗
        </RouterLink>
        <a
          v-if="applied.videoUrl"
          :href="applied.videoUrl"
          target="_blank"
          class="border border-ink px-2 py-0.5 text-[11px] font-bold uppercase tracking-[0.08em] hover:bg-ink hover:text-acid"
        >
          Videoraum ↗
        </a>
        <button class="ml-auto text-xs text-ink/60 hover:text-ink" @click="applied = null">
          schließen
        </button>
      </div>
    </div>

    <!-- Plan-Vorschau -->
    <div v-if="plan" class="border-t border-line">
      <div class="flex flex-wrap items-start gap-3 bg-paper-2 px-4 py-3">
        <span class="badge" :class="confidenceTone[plan.confidence]">
          {{ plan.confidence === 'high' ? 'sicher' : plan.confidence === 'medium' ? 'mit Annahmen' : 'unsicher' }}
        </span>
        <p class="min-w-0 flex-1 text-sm font-medium">{{ plan.understood }}</p>
      </div>

      <div class="grid gap-6 px-4 py-4 lg:grid-cols-[1fr_280px]">
        <!-- Editierbare Felder -->
        <div class="space-y-4">
          <div v-if="plan.event.create" class="grid gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="label">Titel</label>
              <input v-model="plan.event.title" class="input" />
            </div>
            <div>
              <label class="label">Beginn</label>
              <input
                :value="toLocalInput(plan.event.startsAt)"
                type="datetime-local"
                class="input"
                @input="plan.event.startsAt = fromLocalInput(($event.target as HTMLInputElement).value)"
              />
            </div>
            <div>
              <label class="label">Ende</label>
              <input
                :value="toLocalInput(plan.event.endsAt)"
                type="datetime-local"
                class="input"
                @input="plan.event.endsAt = fromLocalInput(($event.target as HTMLInputElement).value)"
              />
            </div>
            <label class="flex items-center gap-2 text-sm sm:col-span-2">
              <input v-model="plan.event.withVideo" type="checkbox" />
              Videoraum anlegen
            </label>
          </div>

          <div v-if="plan.project.action === 'create'" class="grid gap-3 sm:grid-cols-3">
            <div>
              <label class="label">Projektkürzel</label>
              <input v-model="plan.project.key" class="input uppercase" />
            </div>
            <div class="sm:col-span-2">
              <label class="label">Projektname</label>
              <input v-model="plan.project.name" class="input" />
            </div>
          </div>

          <div v-if="plan.client.action === 'create'" class="grid gap-3 sm:grid-cols-2">
            <div>
              <label class="label">Kunde</label>
              <input v-model="plan.client.name" class="input" />
            </div>
            <div>
              <label class="label">Firma</label>
              <input v-model="plan.client.company" class="input" />
            </div>
          </div>

          <div v-if="plan.note.create">
            <label class="label">Notiz</label>
            <input v-model="plan.note.title" class="input mb-2" />
            <textarea v-model="plan.note.body" rows="3" class="input font-mono text-xs" />
          </div>

          <p v-if="!willCreate.length" class="text-sm text-muted">
            Aus dem Satz lässt sich nichts Anlegbares ableiten. Formuliere konkreter, z.B. mit
            Zeitpunkt oder Kundennamen.
          </p>
        </div>

        <!-- Zusammenfassung + Bestätigung -->
        <aside class="space-y-4">
          <div>
            <h3 class="eyebrow-muted mb-2">Wird angelegt</h3>
            <ul class="space-y-1 text-sm">
              <li v-for="item in willCreate" :key="item" class="flex gap-2">
                <span class="text-blue">+</span><span>{{ item }}</span>
              </li>
            </ul>
          </div>

          <div v-if="plan.questions.length">
            <h3 class="eyebrow-muted mb-2 !text-warn">Angenommen</h3>
            <ul class="space-y-1 text-xs text-soft">
              <li v-for="q in plan.questions" :key="q" class="border-l-2 border-warn/50 pl-2">
                {{ q }}
              </li>
            </ul>
          </div>

          <div class="flex gap-2 border-t border-line pt-3">
            <button class="btn-ghost" :disabled="busy" @click="discard">Verwerfen</button>
            <button class="btn-acid flex-1 justify-center" :disabled="busy || !willCreate.length" @click="apply">
              {{ busy ? 'Legt an …' : 'Anlegen' }}
            </button>
          </div>
        </aside>
      </div>
    </div>
  </section>
</template>
