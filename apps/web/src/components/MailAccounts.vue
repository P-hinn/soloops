<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'

type Account = {
  id: string
  label: string
  email: string
  imapHost: string
  imapPort: number
  imapUser: string
  folders: string[]
  enabled: boolean
  lastSyncAt: string | null
  lastError: string | null
}

const accounts = ref<Account[]>([])
const showForm = ref(false)
const busy = ref(false)
const error = ref('')

const draft = ref({
  label: 'Geschäftlich',
  email: '',
  imapHost: '',
  imapPort: 993,
  imapUser: '',
  password: '',
})

/** Saves looking it up in the most common case. */
const PRESETS: Record<string, string> = {
  'strato.de': 'imap.strato.de',
  'mailbox.org': 'imap.mailbox.org',
  'posteo.de': 'posteo.de',
  'gmail.com': 'imap.gmail.com',
  'ionos.de': 'imap.ionos.de',
  'all-inkl.com': 'w01a.kasserver.com',
}

function guessHost() {
  if (!draft.value.email.includes('@')) return
  draft.value.imapUser ||= draft.value.email
  if (draft.value.imapHost) return
  const domain = draft.value.email.split('@')[1]?.toLowerCase() ?? ''
  draft.value.imapHost = PRESETS[domain] ?? `imap.${domain}`
}

const when = (v: string | null) => (v ? new Date(v).toLocaleString('de-DE') : 'nie')

async function load() {
  accounts.value = await api.get<Account[]>('/api/mail/accounts')
}

async function add() {
  busy.value = true
  error.value = ''
  try {
    await api.post('/api/mail/accounts', draft.value)
    draft.value = {
      label: 'Geschäftlich',
      email: '',
      imapHost: '',
      imapPort: 993,
      imapUser: '',
      password: '',
    }
    showForm.value = false
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function sync(id: string) {
  busy.value = true
  try {
    await api.post(`/api/mail/accounts/${id}/sync`, {})
    await load()
  } finally {
    busy.value = false
  }
}

async function remove(id: string) {
  await api.del(`/api/mail/accounts/${id}`)
  await load()
}

onMounted(load)
</script>

<template>
  <section>
    <div class="mb-3 flex items-baseline justify-between border-b border-line-strong pb-2">
      <h2 class="eyebrow">Postfach</h2>
      <button class="btn-xs" @click="showForm = !showForm">
        {{ showForm ? 'Abbrechen' : 'Postfach verbinden' }}
      </button>
    </div>

    <p class="mb-4 text-sm text-muted">
      soloops liest das Postfach über IMAP, um Mails automatisch Leads, Kunden und Projekten
      zuzuordnen. Es wird <strong>nichts</strong> gelöscht, verschoben oder als gelesen markiert —
      dein Mailclient merkt nicht, dass jemand mitliest. Das Passwort liegt verschlüsselt in der
      Datenbank; nutze wenn möglich ein eigenes App-Passwort.
    </p>

    <form v-if="showForm" class="card mb-5 space-y-3 p-4" @submit.prevent="add">
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="label">
          Bezeichnung
          <input v-model="draft.label" class="input" />
        </label>
        <label class="label">
          E-Mail-Adresse
          <input v-model="draft.email" type="email" class="input" @blur="guessHost" />
        </label>
        <label class="label">
          IMAP-Server
          <input v-model="draft.imapHost" class="input" placeholder="imap.strato.de" />
        </label>
        <label class="label">
          Port
          <input v-model.number="draft.imapPort" type="number" class="input" />
        </label>
        <label class="label">
          Benutzername
          <input v-model="draft.imapUser" class="input" />
        </label>
        <label class="label">
          Passwort
          <input v-model="draft.password" type="password" class="input" autocomplete="off" />
        </label>
      </div>
      <p v-if="error" class="text-sm text-bad">{{ error }}</p>
      <button class="btn-primary" :disabled="busy">
        {{ busy ? 'prüft Anmeldung …' : 'Verbinden' }}
      </button>
    </form>

    <table v-if="accounts.length" class="table">
      <thead>
        <tr>
          <th>Postfach</th>
          <th>Server</th>
          <th>Zuletzt gelesen</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="a in accounts" :key="a.id">
          <td>
            <div class="font-medium">{{ a.email }}</div>
            <div class="text-xs text-muted">{{ a.label }} · {{ a.folders.join(', ') }}</div>
          </td>
          <td class="text-muted">{{ a.imapHost }}:{{ a.imapPort }}</td>
          <td>
            <div class="tabular-nums">{{ when(a.lastSyncAt) }}</div>
            <div v-if="a.lastError" class="text-xs text-bad">{{ a.lastError }}</div>
            <div v-else-if="!a.enabled" class="text-xs text-warn">deaktiviert</div>
          </td>
          <td class="text-right">
            <button class="btn-xs" :disabled="busy" @click="sync(a.id)">Abrufen</button>
            <button class="btn-xs" @click="remove(a.id)">Entfernen</button>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else-if="!showForm" class="text-sm text-muted">Kein Postfach verbunden.</p>
  </section>
</template>
