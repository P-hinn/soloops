<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '@/stores/auth'
import BrandMark from '@/components/brand/BrandMark.vue'

const auth = useAuth()
const router = useRouter()
const email = ref('')
const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  error.value = ''
  busy.value = true
  try {
    await auth.login(email.value, password.value)
    router.push('/')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="flex min-h-screen bg-paper">
    <!-- Linke Hälfte: die Aussage, wie auf der Website -->
    <div class="hidden flex-1 flex-col justify-between border-r border-line p-12 lg:flex">
      <div class="flex items-center gap-3">
        <span class="flex h-11 w-11 items-center justify-center bg-ink text-paper">
          <BrandMark :size="26" />
        </span>
        <span class="flex items-baseline gap-2">
          <span class="font-display text-2xl font-bold tracking-tight">soloops</span>
          <span class="h-2 w-2 rounded-full bg-acid" />
        </span>
      </div>

      <div>
        <div class="eyebrow mb-4">Selbstständigkeit · ein Ort · keine Tabs</div>
        <h1 class="max-w-xl font-display text-6xl font-semibold leading-[0.92] tracking-[-0.03em]">
          Alles,<br />was der Tag<br />verlangt.
        </h1>
        <p class="mt-6 max-w-md text-soft">
          Kalender, Meetings, Transkripte, Projekte, Zeiten, Rechnungen und Betrieb —
          in einem System, das dir gehört.
        </p>
      </div>

      <div class="flex gap-8 border-t border-line pt-6">
        <div>
          <div class="font-display text-lg font-semibold">11</div>
          <div class="text-xs text-muted">Module</div>
        </div>
        <div>
          <div class="font-display text-lg font-semibold">0</div>
          <div class="text-xs text-muted">Abos</div>
        </div>
        <div>
          <div class="font-display text-lg font-semibold">lokal</div>
          <div class="text-xs text-muted">Transkription</div>
        </div>
      </div>
    </div>

    <!-- Rechte Hälfte: das Formular -->
    <div class="flex w-full items-center justify-center p-8 lg:w-[460px]">
      <form class="w-full max-w-sm" @submit.prevent="submit">
        <div class="eyebrow mb-2">Anmeldung</div>
        <h2 class="display-lg mb-8">Willkommen zurück.</h2>

        <div class="space-y-5">
          <div>
            <label class="label">E-Mail</label>
            <input v-model="email" type="email" class="input" autocomplete="username" required />
          </div>
          <div>
            <label class="label">Passwort</label>
            <input
              v-model="password"
              type="password"
              class="input"
              autocomplete="current-password"
              required
            />
          </div>
        </div>

        <p v-if="error" class="mt-4 border-l-2 border-bad pl-3 text-sm text-bad">{{ error }}</p>

        <button class="btn-primary mt-8 w-full justify-between" :disabled="busy">
          <span>{{ busy ? 'Anmelden …' : 'Anmelden' }}</span>
          <span aria-hidden="true">↗</span>
        </button>
      </form>
    </div>
  </div>
</template>
