<script setup lang="ts">
/**
 * Everything that joins the two systems, in the order you need it.
 *
 * First the n8n API key, because without it soloops sees nothing. Then the
 * tokens n8n uses to call back in. Then the registered triggers, which are
 * the result of the first two working — they appear by themselves when a
 * workflow with a Soloops Trigger is switched on.
 */
import { ref } from 'vue'
import { api } from '@/api'
import {
  when,
  type AutomationStatus,
  type AutomationToken,
  type AutomationTrigger,
} from '@/lib/automations'

const props = defineProps<{
  status: AutomationStatus
  triggers: AutomationTrigger[]
  tokens: AutomationToken[]
  /** What goes into the n8n credential's Base URL field. */
  baseUrl: string
}>()

const emit = defineEmits<{ changed: [] }>()

const error = ref('')
const busy = ref('')

// --- n8n API key -----------------------------------------------------------

const apiKey = ref('')

async function saveApiKey() {
  busy.value = 'apiKey'
  error.value = ''
  try {
    await api.post('/api/automations/api-key', { apiKey: apiKey.value.trim() })
    apiKey.value = ''
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function clearApiKey() {
  busy.value = 'apiKey'
  try {
    await api.del('/api/automations/api-key')
    emit('changed')
  } finally {
    busy.value = ''
  }
}

// --- Automation tokens -----------------------------------------------------

const tokenName = ref('')
const tokenWrite = ref(true)
/**
 * The freshly minted token. Held in memory only and never fetched again —
 * soloops stores a hash, so this is the one moment it exists in readable form.
 */
const freshToken = ref<{ token: string; prefix: string } | null>(null)

async function mintToken() {
  busy.value = 'token'
  error.value = ''
  try {
    freshToken.value = await api.post<{ token: string; prefix: string }>(
      '/api/automations/tokens',
      {
        name: tokenName.value.trim() || 'n8n',
        scopes: tokenWrite.value ? ['read', 'write'] : ['read'],
      },
    )
    tokenName.value = ''
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function revokeToken(token: AutomationToken) {
  busy.value = token.id
  try {
    await api.post(`/api/automations/tokens/${token.id}/revoke`)
    emit('changed')
  } finally {
    busy.value = ''
  }
}

async function deleteToken(token: AutomationToken) {
  busy.value = token.id
  try {
    await api.del(`/api/automations/tokens/${token.id}`)
    emit('changed')
  } finally {
    busy.value = ''
  }
}

// --- Triggers --------------------------------------------------------------

async function toggleTrigger(trigger: AutomationTrigger) {
  busy.value = trigger.id
  try {
    await api.patch(`/api/automations/triggers/${trigger.id}`, { enabled: !trigger.enabled })
    emit('changed')
  } finally {
    busy.value = ''
  }
}

async function deleteTrigger(trigger: AutomationTrigger) {
  busy.value = trigger.id
  try {
    await api.del(`/api/automations/triggers/${trigger.id}`)
    emit('changed')
  } finally {
    busy.value = ''
  }
}

const copy = (text: string) => navigator.clipboard?.writeText(text)

/**
 * An n8n expression, shown as an example. A constant rather than inline in the
 * template: nested curly braces inside an interpolation are the one thing
 * Vue's template parser cannot read.
 */
const EXPRESSION_EXAMPLE = '{{ $json.data.id }}'
</script>

<template>
  <div class="space-y-8">
    <p v-if="error" class="text-sm text-bad">{{ error }}</p>

    <!-- ------------------------------------------------------------------ -->
    <!-- 1. soloops reads n8n                                                -->
    <!-- ------------------------------------------------------------------ -->
    <section class="card">
      <h2 class="eyebrow mb-1">1 · soloops liest n8n</h2>
      <p class="mb-4 max-w-2xl text-sm text-muted">
        Der Key wird in n8n erzeugt — <strong>Settings → n8n API → Create an API key</strong> — und
        kann nicht von außen gesetzt werden. Ohne ihn funktioniert der Builder, aber Flows, Vorlagen
        und das Monitoring bleiben leer.
      </p>

      <div class="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <span v-if="props.status.authorized" class="badge badge-good">Key akzeptiert</span>
        <span v-else-if="props.status.hasApiKey" class="badge badge-bad">Key abgelehnt</span>
        <span v-else class="badge bg-paper-2 text-muted">kein Key</span>
        <span v-if="props.status.reachable" class="badge badge-blue">n8n erreichbar</span>
        <span v-else class="badge badge-bad">n8n nicht erreichbar</span>
        <span v-if="props.status.error" class="text-xs text-bad">{{ props.status.error }}</span>
      </div>

      <form class="flex flex-wrap items-end gap-2" @submit.prevent="saveApiKey">
        <label class="label flex-1 min-w-64">
          n8n-API-Key
          <input
            v-model="apiKey"
            type="password"
            class="input mt-1"
            placeholder="n8n_api_…"
            autocomplete="off"
          />
        </label>
        <button class="btn-primary" :disabled="busy === 'apiKey' || apiKey.trim().length < 10">
          Prüfen und speichern
        </button>
        <button
          v-if="props.status.hasApiKey"
          type="button"
          class="btn-ghost"
          :disabled="busy === 'apiKey'"
          @click="clearApiKey"
        >
          Entfernen
        </button>
      </form>
      <p class="mt-2 text-xs text-muted">
        Wird vor dem Speichern gegen n8n geprüft — ein Key, der nicht funktioniert, wird nicht
        übernommen.
      </p>
    </section>

    <!-- ------------------------------------------------------------------ -->
    <!-- 2. n8n writes into soloops                                          -->
    <!-- ------------------------------------------------------------------ -->
    <section class="card">
      <h2 class="eyebrow mb-1">2 · n8n schreibt in soloops</h2>
      <p class="mb-4 max-w-2xl text-sm text-muted">
        Ein Token pro Verbindung, einzeln widerrufbar. Absichtlich nicht der
        <code class="font-mono text-ink">SERVICE_TOKEN</code> — der öffnet auch die Mac-App und den
        MCP-Server. Ein Automations-Token gilt nur für die Konnektor-Schnittstelle.
      </p>

      <form class="mb-4 flex flex-wrap items-end gap-2" @submit.prevent="mintToken">
        <label class="label flex-1 min-w-48">
          Name
          <input v-model="tokenName" class="input mt-1" placeholder="n8n" />
        </label>
        <label class="flex items-center gap-2 pb-2 text-sm">
          <input v-model="tokenWrite" type="checkbox" />
          darf schreiben
        </label>
        <button class="btn-primary" :disabled="busy === 'token'">Token erzeugen</button>
      </form>

      <!-- Shown once, then gone for good -->
      <div v-if="freshToken" class="mb-4 border border-ink bg-acid px-4 py-3">
        <div class="eyebrow-muted !text-ink/60">Nur jetzt sichtbar</div>
        <div class="mt-1 flex flex-wrap items-center gap-2">
          <code class="break-all font-mono text-sm">{{ freshToken.token }}</code>
          <button
            class="shrink-0 rounded-full border border-ink px-3 py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors hover:bg-ink hover:text-acid"
            @click="copy(freshToken.token)"
          >
            Kopieren
          </button>
        </div>
        <p class="mt-2 text-xs text-ink/70">
          In n8n unter Credentials → „soloops API“ eintragen. Base URL:
          <code class="font-mono">{{ props.baseUrl }}</code>
        </p>
      </div>

      <table class="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Token</th>
            <th>Rechte</th>
            <th>Zuletzt benutzt</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="token in props.tokens" :key="token.id">
            <td>
              {{ token.name }}
              <span v-if="token.revokedAt" class="badge badge-bad ml-1.5">widerrufen</span>
            </td>
            <td class="font-mono text-xs text-muted">{{ token.prefix }}…</td>
            <td class="text-xs">{{ token.scopes.join(' + ') }}</td>
            <td class="text-xs text-muted">{{ when(token.lastUsedAt) }}</td>
            <td class="text-right">
              <button
                v-if="!token.revokedAt"
                class="btn-ghost btn-xs"
                :disabled="busy === token.id"
                @click="revokeToken(token)"
              >
                Widerrufen
              </button>
              <button
                v-else
                class="btn-danger btn-xs"
                :disabled="busy === token.id"
                @click="deleteToken(token)"
              >
                Löschen
              </button>
            </td>
          </tr>
          <tr v-if="!props.tokens.length">
            <td colspan="5" class="py-6 text-center text-muted">Noch kein Token.</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- ------------------------------------------------------------------ -->
    <!-- 3. soloops pushes events                                            -->
    <!-- ------------------------------------------------------------------ -->
    <section class="card">
      <h2 class="eyebrow mb-1">3 · soloops schickt Events</h2>
      <p class="mb-4 max-w-2xl text-sm text-muted">
        Diese Einträge legt die <strong>Soloops Trigger</strong>-Node selbst an, sobald du den
        Workflow in n8n einschaltest — nichts zu kopieren. Jede Zustellung wird protokolliert; nach
        zu vielen Fehlversuchen schaltet sich ein Trigger ab, statt weiter ins Leere zu rufen.
      </p>

      <div class="space-y-3">
        <div
          v-for="trigger in props.triggers"
          :key="trigger.id"
          class="border border-line bg-paper-2 p-3"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="badge badge-acid">{{ trigger.wire }}</span>
                <span class="text-sm">{{ trigger.label }}</span>
                <a
                  v-if="trigger.flow"
                  :href="`/n8n/workflow/${trigger.flow.n8nId}`"
                  target="_blank"
                  rel="noopener"
                  class="text-xs text-blue hover:underline"
                >
                  {{ trigger.flow.name }}
                </a>
                <span v-if="trigger.project" class="badge bg-paper-2 text-soft">
                  nur {{ trigger.project.key }}
                </span>
                <span v-if="!trigger.enabled" class="badge badge-bad">aus</span>
              </div>
              <div class="mt-1 break-all font-mono text-[11px] text-muted">
                {{ trigger.webhookUrl }}
              </div>
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <button
                class="btn-ghost btn-xs"
                :disabled="busy === trigger.id"
                @click="toggleTrigger(trigger)"
              >
                {{ trigger.enabled ? 'Aus' : 'An' }}
              </button>
              <button
                class="btn-danger btn-xs"
                :disabled="busy === trigger.id"
                @click="deleteTrigger(trigger)"
              >
                Löschen
              </button>
            </div>
          </div>

          <p v-if="trigger.disabledByFailures" class="mt-2 text-xs text-bad">
            Nach {{ trigger.failStreak }} Fehlversuchen abgeschaltet: {{ trigger.lastError }}. „An“
            setzt den Zähler zurück.
          </p>
          <p v-else-if="trigger.lastError" class="mt-2 text-xs text-warn">
            Letzter Fehler: {{ trigger.lastError }} ({{ trigger.failStreak }}×)
          </p>

          <!-- The delivery log: the only thing that makes a dead webhook visible -->
          <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <span class="text-muted">zuletzt gefeuert {{ when(trigger.lastFiredAt) }}</span>
            <span
              v-for="delivery in trigger.deliveries"
              :key="delivery.id"
              class="px-1.5 py-0.5"
              :class="delivery.ok ? 'bg-good/10 text-good' : 'bg-bad/10 text-bad'"
              :title="`${when(delivery.at)} · Versuch ${delivery.attempt}${delivery.error ? ` · ${delivery.error}` : ''}`"
            >
              {{ delivery.httpStatus ?? 'Netz' }}
            </span>
          </div>
        </div>

        <p v-if="!props.triggers.length" class="py-6 text-center text-sm text-muted">
          Noch kein Trigger registriert. Leg einen Workflow mit einer Soloops-Trigger-Node an und
          schalte ihn ein.
        </p>
      </div>
    </section>

    <!-- The event reference, so expressions can be written without guessing -->
    <section class="card">
      <h2 class="eyebrow mb-3">Verfügbare Events</h2>
      <div class="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <div v-for="event in props.status.events" :key="event.wire" class="flex gap-2">
          <code class="shrink-0 font-mono text-xs text-ink">{{ event.wire }}</code>
          <span class="text-muted">{{ event.label }}</span>
        </div>
      </div>
      <p class="mt-4 text-xs text-muted">
        Jedes Event kommt als
        <code class="font-mono text-ink">{ event, at, projectId, url, data }</code> an. Im Workflow
        also <code class="font-mono text-ink">{{ EXPRESSION_EXAMPLE }}</code
        >. Ist ein Secret hinterlegt, trägt die Zustellung zusätzlich
        <code class="font-mono text-ink">X-Soloops-Signature</code> (HMAC-SHA256 über den Body).
      </p>
    </section>
  </div>
</template>
