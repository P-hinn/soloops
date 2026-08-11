<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useAuth } from '@/stores/auth'
import { useTimer } from '@/stores/timer'
import GlobalSearch from '@/components/GlobalSearch.vue'

const auth = useAuth()
const timer = useTimer()
const route = useRoute()

const isPublic = computed(() => route.meta.public === true)

const nav = [
  { to: '/', label: 'Dashboard', icon: '◉' },
  { to: '/calendar', label: 'Kalender', icon: '▦' },
  { to: '/meetings', label: 'Meetings', icon: '☰' },
  { to: '/notes', label: 'Notizen', icon: '✎' },
  { to: '/projects', label: 'Projekte', icon: '◆' },
  { to: '/time', label: 'Zeiten', icon: '⏱' },
  { to: '/invoices', label: 'Rechnungen', icon: '€' },
  { to: '/accounting', label: 'Buchhaltung', icon: '∑' },
  { to: '/ops', label: 'Betrieb', icon: '⚡' },
  { to: '/vault', label: 'Passwörter', icon: '🔒' },
  { to: '/clients', label: 'Kunden', icon: '☺' },
  { to: '/settings', label: 'Einstellungen', icon: '⚙' },
]

onMounted(async () => {
  if (isPublic.value) return
  await auth.load()
  await timer.refresh()
  timer.startTicking()
})

watch(isPublic, async (value) => {
  if (!value && !auth.me) {
    await auth.load()
    await timer.refresh()
    timer.startTicking()
  }
})
</script>

<template>
  <RouterView v-if="isPublic" />

  <div v-else class="flex min-h-screen">
    <aside class="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div class="px-4 py-5">
        <div class="text-lg font-semibold tracking-tight">soloops</div>
        <div class="text-xs text-zinc-500">{{ auth.config?.companyName }}</div>
      </div>

      <nav class="flex-1 space-y-0.5 px-2">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          active-class="bg-zinc-800 text-zinc-100"
        >
          <span class="w-4 text-center text-xs opacity-70">{{ item.icon }}</span>
          {{ item.label }}
        </RouterLink>
      </nav>

      <!-- Laufender Timer, immer sichtbar -->
      <div v-if="timer.running" class="m-2 rounded-lg border border-emerald-900/60 bg-emerald-950/40 p-3">
        <div class="text-[10px] uppercase tracking-wide text-emerald-500">läuft</div>
        <div class="truncate text-sm font-medium">{{ timer.running.project.key }}</div>
        <div class="mt-1 flex items-center justify-between">
          <span class="font-mono text-lg tabular-nums">{{ timer.display }}</span>
          <button class="btn-danger px-2 py-1 text-xs" @click="timer.stop()">Stopp</button>
        </div>
      </div>

      <button class="m-2 mt-0 btn-ghost justify-center" @click="auth.logout()">Abmelden</button>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex items-center gap-4 border-b border-zinc-800 px-6 py-3">
        <GlobalSearch class="flex-1" />
      </header>
      <main class="min-w-0 flex-1 overflow-y-auto p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
