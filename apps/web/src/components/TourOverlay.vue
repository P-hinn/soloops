<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useOnboarding } from '@/stores/onboarding'

/**
 * Geführte Tour mit Scheinwerfer.
 *
 * Der Ausschnitt entsteht über einen riesigen box-shadow statt über eine
 * SVG-Maske — dadurch bleibt das hervorgehobene Element klickbar und der Rest
 * der Seite liegt sichtbar, aber gedämpft darunter.
 *
 * Schritte hängen an `data-tour="…"`-Attributen. Fehlt ein Ziel (weil es zum
 * Zustand nicht existiert, etwa der laufende Timer), wird der Schritt
 * übersprungen statt ins Leere zu zeigen.
 */

type TourStep = {
  target: string | null
  route?: string
  title: string
  body: string
}

const STEPS: TourStep[] = [
  {
    target: null,
    route: '/',
    title: 'Willkommen bei soloops',
    body: 'Ein kurzer Rundgang. Danach weißt du, wo der Tag anfängt und wo das Geld herauskommt. Weiter mit → oder Klick, abbrechen mit Esc.',
  },
  {
    target: '[data-tour="quickbar"]',
    route: '/',
    title: 'Ein Feld für alles',
    body: 'Schreib hin, was passieren soll — „Termin für neues Projekt mit Beispiel GmbH nächste Woche". Daraus wird ein Plan mit Kunde, Projekt, Termin und Videoraum. Angelegt wird erst, wenn du ihn geprüft und bestätigt hast.',
  },
  {
    target: '[data-tour="quick-actions"]',
    route: '/',
    title: 'Schnellaktionen',
    body: 'Für alles, was keinen Satz braucht: Timer starten und stoppen, Meeting, Termin, Notiz, Abrechnen. Der laufende Timer bleibt links in der Leiste sichtbar, egal wo du gerade bist.',
  },
  {
    target: '[data-tour="nav"]',
    route: '/',
    title: 'Drei Blöcke, eine Reihenfolge',
    body: 'Arbeiten ist der Tag: Kalender, Meetings, Notizen, Projekte. Abrechnen ist das Geld: Zeiten werden zu Rechnungen, Rechnungen zur Buchhaltung. Betrieb ist alles, was ohne dich läuft.',
  },
  {
    target: '[data-tour="search"]',
    route: '/',
    title: 'Suche über alles',
    body: 'Ein Feld für Notizen, Meeting-Transkripte, Projekte, Kunden und Rechnungsnummern. Mit ⌘K von überall erreichbar — auch mitten im Gespräch.',
  },
  {
    target: '[data-tour="checklist"]',
    route: '/',
    title: 'Einrichtung',
    body: 'Die Liste liest den echten Zustand: sie hakt nur ab, was tatsächlich existiert. Der hervorgehobene Punkt ist der nächste sinnvolle Schritt. Ausblenden geht jederzeit, in den Einstellungen holst du sie zurück.',
  },
  {
    target: '[data-tour="nav-settings"]',
    route: '/',
    title: 'Hier hängt der Rest',
    body: 'Google- und Apple-Kalender verbinden, Dienste prüfen, MCP-Server in Claude registrieren. Was über die .env läuft, steht dort mit Variablennamen dabei.',
  },
]

const onboarding = useOnboarding()
const router = useRouter()

const index = ref(0)
const rect = ref<DOMRect | null>(null)
const step = computed(() => STEPS[index.value] ?? null)
const isLast = computed(() => index.value >= STEPS.length - 1)

/** Zielelement suchen, sichtbar scrollen, Position merken. */
async function locate(): Promise<void> {
  const current = step.value
  if (!current) return

  if (current.route && router.currentRoute.value.path !== current.route) {
    await router.push(current.route)
  }
  await nextTick()
  // Layout und Seitenübergang abwarten
  await new Promise((r) => setTimeout(r, 180))

  if (!current.target) {
    rect.value = null
    return
  }
  const el = document.querySelector(current.target)
  if (!el) {
    // Ziel existiert im aktuellen Zustand nicht — Schritt überspringen.
    if (!isLast.value) {
      index.value++
      await locate()
    } else {
      rect.value = null
    }
    return
  }
  // Hart scrollen statt weich: bei 'smooth' wäre die Messung ein Rennen gegen
  // die Animation, und der Scheinwerfer landet neben dem Ziel.
  el.scrollIntoView({ behavior: 'auto', block: 'center' })
  await nextTick()

  const box = el.getBoundingClientRect()
  // Unbrauchbare Messung (verstecktes Element, kollabiertes Layout): lieber
  // zentriert und gleichmäßig abdunkeln als einen Scheinwerfer ins Nichts.
  const usable =
    box.width > 0 &&
    box.height > 0 &&
    box.bottom > 0 &&
    box.top < window.innerHeight &&
    window.innerHeight > 0
  rect.value = usable ? box : null
}

async function next() {
  if (isLast.value) return finish()
  index.value++
  await locate()
}

async function prev() {
  if (index.value === 0) return
  index.value--
  await locate()
}

function finish() {
  onboarding.closeTour()
  index.value = 0
}

function onKey(event: KeyboardEvent) {
  if (!onboarding.tourOpen) return
  if (event.key === 'Escape') finish()
  if (event.key === 'ArrowRight' || event.key === 'Enter') next()
  if (event.key === 'ArrowLeft') prev()
}

function onResize() {
  if (onboarding.tourOpen) locate()
}

watch(
  () => onboarding.tourOpen,
  (open) => {
    if (open) {
      index.value = 0
      locate()
      window.addEventListener('keydown', onKey)
      window.addEventListener('resize', onResize)
    } else {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  },
)

onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
})

const PAD = 8

const spotlight = computed(() => {
  if (!rect.value) return null
  return {
    top: `${rect.value.top - PAD}px`,
    left: `${rect.value.left - PAD}px`,
    width: `${rect.value.width + PAD * 2}px`,
    height: `${rect.value.height + PAD * 2}px`,
  }
})

const CARD_W = 380
/** Geschätzte Höhe für die Platzierung; danach wird ohnehin geklemmt. */
const CARD_H = 250

/**
 * Karte unter das Ziel, sonst darüber — und in jedem Fall in den sichtbaren
 * Bereich geklemmt. Ohne die Klemmung rutscht sie bei Zielen am unteren Rand
 * aus dem Bild, und der Text ist nicht mehr lesbar.
 */
const card = computed(() => {
  if (!rect.value) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }
  }
  const gap = PAD + 12
  const maxTop = Math.max(16, window.innerHeight - CARD_H - 16)

  const below = rect.value.bottom + gap
  const above = rect.value.top - gap - CARD_H
  const top = below + CARD_H + 16 <= window.innerHeight ? below : above >= 16 ? above : maxTop

  const left = Math.min(
    Math.max(16, rect.value.left),
    Math.max(16, window.innerWidth - CARD_W - 16),
  )
  return { top: `${Math.min(Math.max(16, top), maxTop)}px`, left: `${left}px` }
})
</script>

<template>
  <Teleport to="body">
    <div v-if="onboarding.tourOpen && step" class="fixed inset-0 z-[100]">
      <!-- Scheinwerfer: Loch im abgedunkelten Rest -->
      <div
        v-if="spotlight"
        class="pointer-events-none absolute border-2 border-acid transition-all duration-200"
        :style="{ ...spotlight, boxShadow: '0 0 0 9999px rgba(23,23,20,0.55)' }"
      />
      <!-- Ohne Ziel: gleichmäßige Abdunklung -->
      <div v-else class="absolute inset-0 bg-ink/55" />

      <!-- Klickfänger, damit die Seite während der Tour ruhig bleibt -->
      <div class="absolute inset-0" @click="next" />

      <div
        class="popover absolute flex max-h-[calc(100vh-2rem)] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden"
        :style="card"
      >
        <div class="flex items-center gap-2 border-b border-ink bg-acid px-4 py-2">
          <span class="eyebrow-muted !text-ink">Rundgang</span>
          <span class="font-display text-xs font-semibold tabular-nums">
            {{ index + 1 }} / {{ STEPS.length }}
          </span>
          <button class="ml-auto text-xs text-ink/60 hover:text-ink" @click="finish">
            überspringen
          </button>
        </div>

        <div class="min-h-0 overflow-y-auto p-4">
          <h3 class="font-display text-lg font-semibold leading-snug tracking-[-0.01em]">
            {{ step.title }}
          </h3>
          <p class="mt-2 text-sm leading-relaxed text-soft">{{ step.body }}</p>

          <div class="mt-4 flex items-center gap-2">
            <button v-if="index > 0" class="btn-ghost" @click="prev">Zurück</button>
            <div class="flex flex-1 gap-1">
              <span
                v-for="(_, i) in STEPS"
                :key="i"
                class="h-1 flex-1"
                :class="i <= index ? 'bg-ink' : 'bg-line'"
              />
            </div>
            <button class="btn-primary" @click="next">
              <span>{{ isLast ? 'Fertig' : 'Weiter' }}</span>
              <span v-if="!isLast" aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
