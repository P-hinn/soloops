<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuth } from '@/stores/auth'

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
  <div class="flex min-h-screen items-center justify-center p-6">
    <form class="card w-full max-w-sm space-y-4" @submit.prevent="submit">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">soloops</h1>
        <p class="text-sm text-zinc-500">Anmeldung</p>
      </div>

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

      <p v-if="error" class="text-sm text-red-400">{{ error }}</p>

      <button class="btn-primary w-full justify-center" :disabled="busy">
        {{ busy ? 'Anmelden …' : 'Anmelden' }}
      </button>
    </form>
  </div>
</template>
