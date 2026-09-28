<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'

type Mail = {
  id: string
  subject: string
  fromName: string | null
  fromEmail: string
  sentAt: string
  snippet: string
  bodyText?: string
  category: string
  assignedBy: string
  confidence: number | null
  aiReason: string | null
  handled: boolean
  lead: { id: string; title: string } | null
  client: { id: string; name: string } | null
  project: { id: string; key: string } | null
}
type Lead = { id: string; title: string }
type Client = { id: string; name: string }
type Account = { id: string; email: string; lastSyncAt: string | null; lastError: string | null }

const CATEGORY_LABEL: Record<string, string> = {
  LEAD: 'Lead',
  PROJECT: 'Projekt',
  INVOICE: 'Rechnung',
  ADMIN: 'Verwaltung',
  OTHER: 'Sonstiges',
}
const CATEGORY_TONE: Record<string, string> = {
  LEAD: 'badge-acid',
  PROJECT: 'badge-blue',
  INVOICE: '',
  ADMIN: '',
  OTHER: '',
}

const mails = ref<Mail[]>([])
const leads = ref<Lead[]>([])
const clients = ref<Client[]>([])
const accounts = ref<Account[]>([])
const filter = ref<'open' | 'unassigned' | 'all'>('open')
const open = ref<string | null>(null)
const syncing = ref(false)
const error = ref('')

const hasAccount = computed(() => accounts.value.length > 0)

const query = computed(() => {
  if (filter.value === 'unassigned') return { unassigned: true, handled: false, take: 100 }
  if (filter.value === 'open') return { handled: false, take: 100 }
  return { take: 100 }
})

const when = (v: string) =>
  new Date(v).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

async function load() {
  const [list, accs] = await Promise.all([
    api.get<Mail[]>('/api/mail', query.value),
    api.get<Account[]>('/api/mail/accounts'),
  ])
  mails.value = list
  accounts.value = accs
}

async function loadTargets() {
  const [l, c] = await Promise.all([
    api.get<Lead[]>('/api/leads', { open: true }),
    api.get<Client[]>('/api/clients'),
  ])
  leads.value = l
  clients.value = c
}

async function sync() {
  syncing.value = true
  error.value = ''
  try {
    const results = await api.post<{ fetched: number; error?: string }[]>('/api/mail/sync')
    const failed = results.find((r) => r.error)
    if (failed) error.value = failed.error ?? ''
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    syncing.value = false
  }
}

async function assign(mail: Mail, data: Record<string, unknown>) {
  await api.patch(`/api/mail/${mail.id}`, data)
  await load()
}

async function makeLead(mail: Mail) {
  await api.post(`/api/mail/${mail.id}/lead`, {})
  await Promise.all([load(), loadTargets()])
}

onMounted(async () => {
  await Promise.all([load(), loadTargets()])
})
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Postfach"
      title="Eingang"
      subtitle="Was das System selbst zugeordnet hat — und was es dir überlässt."
    >
      <template #actions>
        <button v-if="hasAccount" class="btn-ghost" :disabled="syncing" @click="sync">
          {{ syncing ? 'liest …' : 'Jetzt abrufen' }}
        </button>
      </template>
    </PageHeader>

    <div v-if="!hasAccount" class="card p-6">
      <p class="text-sm">
        Noch kein Postfach verbunden. Unter
        <RouterLink to="/settings" class="text-blue underline">Einstellungen</RouterLink>
        lässt sich eins per IMAP hinzufügen — soloops liest dort ausschließlich, es löscht,
        verschiebt und markiert nichts.
      </p>
    </div>

    <template v-else>
      <p v-if="error" class="mb-5 text-sm text-bad">{{ error }}</p>

      <div class="mb-6 flex flex-wrap items-center gap-1.5">
        <button
          v-for="(label, key) in { open: 'Offen', unassigned: 'Nicht zugeordnet', all: 'Alle' }"
          :key="key"
          class="btn-xs"
          :class="filter === key ? 'btn-primary' : ''"
          @click="
            filter = key as 'open' | 'unassigned' | 'all'
            load()
          "
        >
          {{ label }}
        </button>
        <span v-if="accounts[0]?.lastSyncAt" class="ml-auto text-xs text-muted">
          zuletzt gelesen {{ when(accounts[0].lastSyncAt) }}
        </span>
      </div>

      <p v-if="accounts[0]?.lastError" class="mb-5 text-sm text-bad">
        Letzter Abruf fehlgeschlagen: {{ accounts[0].lastError }}
      </p>

      <ol v-if="mails.length" class="space-y-0">
        <li v-for="mail in mails" :key="mail.id" class="border-b border-line">
          <button
            class="flex w-full items-baseline gap-4 py-3 text-left"
            @click="open = open === mail.id ? null : mail.id"
          >
            <span class="w-24 shrink-0 tabular-nums text-xs text-muted">
              {{ when(mail.sentAt) }}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ mail.subject }}</span>
              <span class="block truncate text-xs text-muted">
                {{ mail.fromName ?? mail.fromEmail }} — {{ mail.snippet }}
              </span>
            </span>
            <span class="flex shrink-0 items-center gap-1.5">
              <span class="badge" :class="CATEGORY_TONE[mail.category]">
                {{ CATEGORY_LABEL[mail.category] }}
              </span>
              <span v-if="mail.lead" class="badge badge-good" :title="'Lead: ' + mail.lead.title">
                ✓
              </span>
              <span v-else-if="mail.client" class="badge badge-good" :title="mail.client.name">
                ✓
              </span>
            </span>
          </button>

          <div v-if="open === mail.id" class="border-t border-line bg-raised p-4">
            <!-- Klartext, nie gerendert: der Inhalt kommt von außen. -->
            <p class="mb-4 max-h-64 overflow-y-auto whitespace-pre-line text-sm">
              {{ mail.snippet }}
            </p>

            <p v-if="mail.aiReason" class="mb-4 text-xs text-muted">
              {{ mail.assignedBy === 'AI' ? 'AI' : 'Regel' }}: {{ mail.aiReason }}
              <template v-if="mail.confidence !== null">
                ({{ Math.round(mail.confidence * 100) }} % sicher)
              </template>
            </p>

            <div class="flex flex-wrap items-end gap-3">
              <label class="label">
                Lead
                <select
                  class="input w-56"
                  :value="mail.lead?.id ?? ''"
                  @change="
                    assign(mail, {
                      leadId: ($event.target as HTMLSelectElement).value || null,
                      category: ($event.target as HTMLSelectElement).value ? 'LEAD' : mail.category,
                    })
                  "
                >
                  <option value="">—</option>
                  <option v-for="l in leads" :key="l.id" :value="l.id">{{ l.title }}</option>
                </select>
              </label>

              <label class="label">
                Kunde
                <select
                  class="input w-56"
                  :value="mail.client?.id ?? ''"
                  @change="
                    assign(mail, { clientId: ($event.target as HTMLSelectElement).value || null })
                  "
                >
                  <option value="">—</option>
                  <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
              </label>

              <button v-if="!mail.lead" class="btn-acid" @click="makeLead(mail)">
                Lead daraus machen
              </button>
              <button class="btn-ghost ml-auto" @click="assign(mail, { handled: !mail.handled })">
                {{ mail.handled ? 'Wieder öffnen' : 'Erledigt' }}
              </button>
            </div>
          </div>
        </li>
      </ol>

      <p v-else class="py-8 text-sm text-muted">
        {{ filter === 'open' ? 'Eingang leer.' : 'Nichts gefunden.' }}
      </p>
    </template>
  </div>
</template>
