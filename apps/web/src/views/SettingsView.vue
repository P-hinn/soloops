<script setup lang="ts">
import { ref } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import { useAuth } from '@/stores/auth'

const auth = useAuth()
const current = ref('')
const next = ref('')
const message = ref('')
const error = ref('')

async function changePassword() {
  message.value = ''
  error.value = ''
  try {
    await api.post('/api/auth/password', { current: current.value, next: next.value })
    message.value = 'Passwort geändert.'
    current.value = ''
    next.value = ''
  } catch (err) {
    error.value = (err as Error).message
  }
}

const featureLabels: Record<string, string> = {
  ai: 'Anthropic (Lageberichte, Meeting-Zusammenfassungen)',
  uptime: 'UptimeRobot',
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  lexoffice: 'lexoffice',
}
</script>

<template>
  <div>
    <PageHeader title="Einstellungen" :subtitle="auth.me?.email" />

    <div class="grid gap-4 lg:grid-cols-2">
      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Angebundene Dienste</h2>
        <p class="mb-3 text-xs text-zinc-500">
          Konfiguration läuft über die <code class="rounded bg-zinc-800 px-1">.env</code>. Nach
          Änderungen <code class="rounded bg-zinc-800 px-1">docker compose up -d</code> ausführen.
        </p>
        <ul class="space-y-2 text-sm">
          <li
            v-for="(label, key) in featureLabels"
            :key="key"
            class="flex items-center justify-between"
          >
            <span>{{ label }}</span>
            <span
              class="badge"
              :class="auth.config?.features[key] ? 'bg-emerald-950 text-emerald-400' : 'bg-zinc-800 text-zinc-500'"
            >
              {{ auth.config?.features[key] ? 'aktiv' : 'nicht konfiguriert' }}
            </span>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Rechnungsstellung</h2>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between">
            <dt class="text-zinc-500">Firmenname</dt>
            <dd>{{ auth.config?.companyName }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-zinc-500">Kleinunternehmer §19</dt>
            <dd>{{ auth.config?.smallBusiness ? 'ja' : 'nein' }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-zinc-500">Standard-USt</dt>
            <dd>{{ auth.config?.defaultTaxRate }} %</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-zinc-500">Standard-Stundensatz</dt>
            <dd>{{ ((auth.config?.defaultHourlyRateCents ?? 0) / 100).toFixed(2) }} €</dd>
          </div>
        </dl>
      </section>

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">Passwort ändern</h2>
        <form class="space-y-3" @submit.prevent="changePassword">
          <div>
            <label class="label">Aktuelles Passwort</label>
            <input v-model="current" type="password" class="input" autocomplete="current-password" />
          </div>
          <div>
            <label class="label">Neues Passwort (min. 10 Zeichen)</label>
            <input v-model="next" type="password" class="input" autocomplete="new-password" />
          </div>
          <p v-if="message" class="text-sm text-emerald-400">{{ message }}</p>
          <p v-if="error" class="text-sm text-red-400">{{ error }}</p>
          <button class="btn-primary">Ändern</button>
        </form>
        <p class="mt-3 text-xs text-zinc-500">
          Das Master-Passwort des Vaults ist davon unabhängig und wird nicht geändert.
        </p>
      </section>

      <section class="card">
        <h2 class="mb-3 text-sm font-semibold">MCP-Server</h2>
        <p class="mb-2 text-xs text-zinc-500">
          Claude Code bekommt Zugriff auf Projekte, Zeiten, Notizen und Rechnungen:
        </p>
        <pre class="overflow-x-auto rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
SOLOOPS_URL=http://localhost:3000 \
SOLOOPS_TOKEN=&lt;SERVICE_TOKEN&gt; \
claude mcp add soloops -- npx tsx apps/mcp/src/index.ts</pre>
      </section>
    </div>
  </div>
</template>
