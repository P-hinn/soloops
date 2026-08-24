<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useAuth } from '@/stores/auth'
import { useTimer } from '@/stores/timer'
import { useOnboarding } from '@/stores/onboarding'
import GlobalSearch from '@/components/GlobalSearch.vue'
import TourOverlay from '@/components/TourOverlay.vue'
import BrandMark from '@/components/brand/BrandMark.vue'

const auth = useAuth()
const timer = useTimer()
const onboarding = useOnboarding()
const route = useRoute()

const isPublic = computed(() => route.meta.public === true)
/** Kalender & Co. bringen ihr eigenes Layout mit und wollen die volle Fläche. */
const isFullBleed = computed(() => route.meta.fullBleed === true)

/** Navigation in drei Blöcken: Tagesgeschäft, Geld, Betrieb & Ablage. */
const navGroups = [
  {
    label: 'Arbeiten',
    items: [
      { to: '/', label: 'Dashboard' },
      { to: '/calendar', label: 'Kalender' },
      { to: '/meetings', label: 'Meetings' },
      { to: '/notes', label: 'Notizen' },
      { to: '/projects', label: 'Projekte' },
    ],
  },
  {
    label: 'Abrechnen',
    items: [
      { to: '/time', label: 'Zeiten' },
      { to: '/invoices', label: 'Rechnungen' },
      { to: '/accounting', label: 'Buchhaltung' },
      { to: '/clients', label: 'Kunden' },
    ],
  },
  {
    label: 'Betrieb',
    items: [
      { to: '/ops', label: 'Uptime & CI' },
      { to: '/vault', label: 'Passwörter' },
      { to: '/settings', label: 'Einstellungen' },
    ],
  },
]

const today = computed(() =>
  new Date().toLocaleDateString('de-DE', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  }),
)

async function boot() {
  await auth.load()
  await timer.refresh()
  timer.startTicking()
  await onboarding.load()
}

onMounted(() => {
  if (!isPublic.value) boot()
})

watch(isPublic, (value) => {
  if (!value && !auth.me) boot()
})
</script>

<template>
  <RouterView v-if="isPublic" />

  <div v-else class="flex h-screen overflow-hidden bg-paper">
    <!-- ------------------------------------------------------------------ -->
    <!-- Seitenleiste                                                        -->
    <!-- ------------------------------------------------------------------ -->
    <aside class="flex w-60 shrink-0 flex-col border-r border-line">
      <RouterLink
        to="/"
        class="group flex items-center gap-3 border-b border-line px-5 py-4 transition-colors hover:bg-ink/[0.03]"
      >
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center bg-ink text-paper transition-colors group-hover:bg-acid group-hover:text-ink"
        >
          <BrandMark :size="20" />
        </span>
        <span class="min-w-0">
          <span class="flex items-baseline gap-1.5">
            <span class="font-display text-xl font-bold leading-none tracking-tight">soloops</span>
            <span class="h-1.5 w-1.5 rounded-full bg-acid" />
          </span>
          <span class="mt-1 block truncate text-[11px] text-muted">
            {{ auth.config?.companyName }}
          </span>
        </span>
      </RouterLink>

      <nav data-tour="nav" class="flex-1 overflow-y-auto py-4">
        <div v-for="group in navGroups" :key="group.label" class="mb-5">
          <div class="eyebrow-muted px-5 pb-1.5">{{ group.label }}</div>
          <!--
            Eigener Slot statt active-class: "/" darf nur exakt aktiv sein,
            "/projects" soll auch auf "/projects/:id" markiert bleiben.
          -->
          <RouterLink
            v-for="item in group.items"
            :key="item.to"
            v-slot="{ href, navigate, isActive, isExactActive }"
            :to="item.to"
            custom
          >
            <a
              :href="href"
              :data-tour="item.to === '/settings' ? 'nav-settings' : undefined"
              class="relative flex items-center px-5 py-1.5 text-sm transition-colors hover:text-ink"
              :class="
                (item.to === '/' ? isExactActive : isActive)
                  ? 'font-medium text-ink'
                  : 'text-soft'
              "
              @click="navigate"
            >
              <!-- Aktivmarkierung: Acid-Balken links, kein Kasten -->
              <span
                v-if="item.to === '/' ? isExactActive : isActive"
                class="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 bg-acid"
              />
              {{ item.label }}
            </a>
          </RouterLink>
        </div>
      </nav>

      <!-- Laufender Timer -->
      <div v-if="timer.running" data-tour="timer" class="border-t border-ink bg-acid px-5 py-3">
        <div class="eyebrow-muted !text-ink/60">läuft</div>
        <div class="mt-0.5 truncate font-display text-sm font-semibold">
          {{ timer.running.project.key }}
        </div>
        <div class="mt-1 flex items-center justify-between gap-2">
          <span class="font-display text-2xl font-semibold tabular-nums leading-none">
            {{ timer.display }}
          </span>
          <button
            class="rounded-full border border-ink px-3 py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors hover:bg-ink hover:text-acid"
            @click="timer.stop()"
          >
            Stopp
          </button>
        </div>
      </div>

      <button
        class="border-t border-line px-5 py-3 text-left text-[11px] font-bold uppercase tracking-[0.12em] text-muted transition-colors hover:bg-ink hover:text-paper"
        @click="auth.logout()"
      >
        Abmelden
      </button>
    </aside>

    <!-- ------------------------------------------------------------------ -->
    <!-- Inhalt                                                              -->
    <!-- ------------------------------------------------------------------ -->
    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-6 border-b border-line px-8 py-3">
        <GlobalSearch data-tour="search" class="max-w-xl flex-1" />
        <div class="ml-auto hidden items-center gap-3 lg:flex">
          <span class="eyebrow-muted">{{ today }}</span>
          <span
            v-if="timer.running"
            class="badge badge-acid"
            :title="timer.running.project.name"
          >
            ● {{ timer.display }}
          </span>
        </div>
      </header>

      <main
        class="min-w-0 flex-1"
        :class="isFullBleed ? 'overflow-hidden' : 'overflow-y-auto px-8 py-8'"
      >
        <RouterView v-slot="{ Component }">
          <Transition name="page" mode="out-in">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <TourOverlay />
  </div>
</template>
