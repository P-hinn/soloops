<script setup lang="ts">
import { ref } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import CalendarAccounts from '@/components/CalendarAccounts.vue'
import MailAccounts from '@/components/MailAccounts.vue'
import ClaudeConnection from '@/components/ClaudeConnection.vue'
import DeviceSync from '@/components/DeviceSync.vue'
import { useAuth } from '@/stores/auth'
import SettingsForm from '@/components/SettingsForm.vue'
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

    <!-- Setup -->
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

    <!-- Calendars: the part that genuinely needs setting up -->
    <CalendarAccounts class="mb-4" />

    <MailAccounts class="mb-4" />

    <SettingsForm
      group="company."
      title="Absenderdaten"
      note="Stehen auf jeder Rechnung. Ohne Adresse, Steuernummer und IBAN ist eine Rechnung formal unvollständig."
      @saved="auth.load()"
    />

    <div class="grid gap-4 lg:grid-cols-2">
      <section class="card">
        <h2 class="eyebrow mb-3">Angebundene Dienste</h2>
        <p class="mb-3 text-xs text-muted">
          Schlüssel können unten eingetragen werden; was in der
          <code class="rounded bg-paper-2 px-1">.env</code> steht, gilt weiter, solange hier nichts
          gesetzt ist. Google und Apple bleiben in der
          <code class="rounded bg-paper-2 px-1">.env</code> — die Redirect-URI muss zu der in der
          Google-Konsole registrierten passen.
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

      <SettingsForm
        group="invoice."
        title="Rechnungsstellung"
        note="Gelten, wenn Kunde und Projekt nichts eigenes sagen."
        @saved="auth.load()"
      />

      <section class="card">
        <h2 class="eyebrow mb-3">Passwort ändern</h2>
        <form class="space-y-3" @submit.prevent="changePassword">
          <div>
            <label for="settings-current-password" class="label">Aktuelles Passwort</label>
            <input
              id="settings-current-password"
              v-model="current"
              type="password"
              class="input"
              autocomplete="current-password"
            />
          </div>
          <div>
            <label for="settings-new-password" class="label"
              >Neues Passwort (min. 10 Zeichen)</label
            >
            <input
              id="settings-new-password"
              v-model="next"
              type="password"
              class="input"
              autocomplete="new-password"
            />
          </div>
          <p v-if="message" class="text-sm text-good">{{ message }}</p>
          <p v-if="error" class="text-sm text-bad">{{ error }}</p>
          <button class="btn-primary">Ändern</button>
        </form>
      </section>

      <SettingsForm
        group="keys."
        title="Schlüssel der angebundenen Dienste"
        note="Verschlüsselt gespeichert. Ein gesetzter Schlüssel wird nie zurückgeschickt — das Feld bleibt leer und ein leeres Feld lässt ihn stehen."
        @saved="auth.load()"
      />

      <SettingsForm
        group="video."
        title="Videoräume"
        note="Jitsi braucht nichts außer der Adresse. CUSTOM nutzt den eigenen Dauerraum."
        @saved="auth.load()"
      />

      <SettingsForm
        group="cron."
        title="Wie oft nachgesehen wird"
        note="Cron-Ausdrücke. Eine Änderung greift innerhalb einer Minute — der Worker plant sich selbst um, ohne Neustart."
        @saved="auth.load()"
      />

      <ClaudeConnection />
      <DeviceSync />
    </div>
  </div>
</template>
