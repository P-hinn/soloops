<script setup lang="ts">
import { ref } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import CalendarAccounts from '@/components/CalendarAccounts.vue'
import { useAuth } from '@/stores/auth'
import { useOnboarding } from '@/stores/onboarding'

const auth = useAuth()
const onboarding = useOnboarding()
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
  ai: 'Anthropic (Lageberichte, Zusammenfassungen, Schnelleingabe)',
  google: 'Google Kalender (OAuth)',
  apple: 'Apple / iCloud (CalDAV)',
  video: 'Videoräume',
  uptime: 'UptimeRobot',
  github: 'GitHub Actions',
  gitlab: 'GitLab CI',
  lexoffice: 'lexoffice',
}
</script>

<template>
  <div>
    <PageHeader title="Einstellungen" :subtitle="auth.me?.email" />

    <!-- Einrichtung -->
    <section class="card mb-4">
      <h2 class="eyebrow mb-1">Einrichtung</h2>
      <p class="mb-4 text-xs text-muted">
        Die Checkliste auf dem Dashboard liest den echten Zustand — sie hakt nur ab, was tatsächlich
        existiert.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <span v-if="onboarding.state" class="font-display text-sm font-semibold tabular-nums">
          {{ onboarding.state.done }} / {{ onboarding.state.total }} erledigt
        </span>
        <button class="btn-ghost" @click="onboarding.openTour()">Rundgang starten</button>
        <button
          v-if="onboarding.state?.dismissed"
          class="btn-ghost"
          @click="onboarding.dismiss(false)"
        >
          Checkliste wieder einblenden
        </button>
        <button
          v-else-if="!onboarding.complete"
          class="btn-ghost"
          @click="onboarding.dismiss(true)"
        >
          Checkliste ausblenden
        </button>
        <span v-if="onboarding.complete" class="text-sm text-good"> Alles eingerichtet. </span>
      </div>
    </section>

    <!-- Kalender: der Teil, der wirklich Einrichtung braucht -->
    <CalendarAccounts class="mb-4" />

    <div class="grid gap-4 lg:grid-cols-2">
      <section class="card">
        <h2 class="eyebrow mb-3">Angebundene Dienste</h2>
        <p class="mb-3 text-xs text-muted">
          Konfiguration läuft über die <code class="rounded bg-paper-2 px-1">.env</code>. Nach
          Änderungen <code class="rounded bg-paper-2 px-1">docker compose up -d</code> ausführen.
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
              :class="auth.config?.features[key] ? 'bg-good/10 text-good' : 'bg-paper-2 text-muted'"
            >
              {{ auth.config?.features[key] ? 'aktiv' : 'nicht konfiguriert' }}
            </span>
          </li>
        </ul>
      </section>

      <section class="card">
        <h2 class="eyebrow mb-3">Rechnungsstellung</h2>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between">
            <dt class="text-muted">Firmenname</dt>
            <dd>{{ auth.config?.companyName }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-muted">Kleinunternehmer §19</dt>
            <dd>{{ auth.config?.smallBusiness ? 'ja' : 'nein' }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-muted">Standard-USt</dt>
            <dd>{{ auth.config?.defaultTaxRate }} %</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-muted">Standard-Stundensatz</dt>
            <dd>{{ ((auth.config?.defaultHourlyRateCents ?? 0) / 100).toFixed(2) }} €</dd>
          </div>
        </dl>
      </section>

      <section class="card">
        <h2 class="eyebrow mb-3">Passwort ändern</h2>
        <form class="space-y-3" @submit.prevent="changePassword">
          <div>
            <label class="label">Aktuelles Passwort</label>
            <input
              v-model="current"
              type="password"
              class="input"
              autocomplete="current-password"
            />
          </div>
          <div>
            <label class="label">Neues Passwort (min. 10 Zeichen)</label>
            <input v-model="next" type="password" class="input" autocomplete="new-password" />
          </div>
          <p v-if="message" class="text-sm text-good">{{ message }}</p>
          <p v-if="error" class="text-sm text-bad">{{ error }}</p>
          <button class="btn-primary">Ändern</button>
        </form>
      </section>

      <section class="card">
        <h2 class="eyebrow mb-3">MCP-Server</h2>
        <p class="mb-2 text-xs text-muted">
          Claude Code bekommt Zugriff auf Projekte, Zeiten, Notizen und Rechnungen:
        </p>
        <pre class="overflow-x-auto bg-paper p-3 text-xs text-soft">
SOLOOPS_URL=http://localhost:3000 \
SOLOOPS_TOKEN=&lt;SERVICE_TOKEN&gt; \
claude mcp add soloops -- npx tsx apps/mcp/src/index.ts</pre>
      </section>
    </div>
  </div>
</template>
