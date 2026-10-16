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
import SettingsSection from '@/components/SettingsSection.vue'
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
  ai: 'Anthropic',
  google: 'Google Kalender',
  apple: 'Apple / iCloud',
  video: 'Videoräume',
  uptime: 'UptimeRobot',
  github: 'GitHub',
  gitlab: 'GitLab',
  lexoffice: 'lexoffice',
}
</script>

<template>
  <div>
    <PageHeader title="Einstellungen" :subtitle="auth.me?.email" />

    <!-- Folded by group, because almost everything here is touched once and
         then never again. What an invoice needs is open to begin with; it is
         the only group that blocks something. -->
    <SettingsSection name="invoicing" title="Rechnungen stellen" open-by-default>
      <SettingsForm
        group="company."
        title="Absenderdaten"
        :columns="2"
        note="Stehen auf jeder Rechnung. Mit * markierte Felder braucht eine Rechnung, um formal vollständig zu sein."
        @saved="auth.load()"
      />

      <SettingsForm
        group="invoice."
        title="Rechnungsstellung"
        note="Gilt, wenn Projekt und Kunde nichts eigenes sagen."
        @saved="auth.load()"
      />
    </SettingsSection>

    <SettingsSection name="accounts" title="Postfach und Kalender">
      <MailAccounts class="mb-4" />
      <CalendarAccounts class="mb-4" />
    </SettingsSection>

    <SettingsSection name="services" title="Angebundene Dienste">
      <section class="card mb-4">
        <h2 class="mb-3 text-sm font-semibold">Was gerade läuft</h2>
        <p class="mb-3 text-xs text-muted">
          Schlüssel stehen unten. Was in der
          <code class="rounded bg-paper-2 px-1">.env</code> steht, gilt weiter, solange hier nichts
          gesetzt ist. Google und Apple bleiben in der
          <code class="rounded bg-paper-2 px-1">.env</code> — die Redirect-URI muss zu der in der
          Google-Konsole registrierten passen.
        </p>
        <ul class="grid gap-x-8 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-3">
          <li
            v-for="(label, key) in featureLabels"
            :key="key"
            class="flex items-center justify-between gap-3 border-b border-line py-1"
          >
            <span>{{ label }}</span>
            <span
              class="badge whitespace-nowrap"
              :class="auth.config?.features[key] ? 'bg-good/10 text-good' : 'bg-paper-2 text-muted'"
            >
              {{ auth.config?.features[key] ? 'aktiv' : 'aus' }}
            </span>
          </li>
        </ul>
      </section>

      <SettingsForm
        group="keys."
        title="Schlüssel"
        note="Verschlüsselt gespeichert und nie zurückgeschickt. Ein leeres Feld lässt einen gesetzten Schlüssel stehen."
        :columns="2"
        @saved="auth.load()"
      />

      <SettingsForm
        group="video."
        title="Videoräume"
        note="Jeder Termin kann einen Raum bekommen — hier steht, woher er kommt."
        :columns="2"
        @saved="auth.load()"
      />
    </SettingsSection>

    <SettingsSection name="intervals" title="Wie oft nachgesehen wird">
      <SettingsForm
        group="cron."
        title="Taktung der Hintergrundläufe"
        note="Eine Änderung greift innerhalb einer Minute — der Worker plant sich selbst um, ohne Neustart."
        @saved="auth.load()"
      />
    </SettingsSection>

    <SettingsSection name="access" title="Zugang und Geräte">
      <div class="grid gap-4 lg:grid-cols-2">
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
      </div>

      <ClaudeConnection class="mt-4" />
      <DeviceSync class="mt-4" />
    </SettingsSection>

    <!-- Last: this is the one block nobody comes here for. It is read once
         while setting the thing up, and the dashboard carries the checklist
         itself. -->
    <SettingsSection
      name="onboarding"
      title="Einrichtung"
      :note="onboarding.complete ? 'fertig' : undefined"
    >
      <section class="card">
        <p class="mb-4 text-xs text-muted">
          Die Checkliste auf dem Dashboard liest den echten Zustand — sie hakt nur ab, was
          tatsächlich existiert.
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
    </SettingsSection>
  </div>
</template>
