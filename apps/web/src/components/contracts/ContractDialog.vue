<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'
import { CONTRACTS, contractByType, draftFor, type ContractType } from '@/lib/contracts'

/**
 * Send a contract to a customer.
 *
 * The type decides the form — the fields are the ones that template has
 * placeholders for. Everything that is always the same (own address, bank
 * details, the clauses themselves) lives in the workflow and is deliberately
 * not editable here: this is the form for what differs per contract, not a
 * document editor.
 */

const props = defineProps<{
  client: { id: string; name: string; company: string | null; email: string | null }
}>()
const emit = defineEmits<{ close: []; sent: [] }>()

const type = ref<ContractType>('nda')
const felder = ref<Record<string, string>>(draftFor('nda'))
const busy = ref(false)
const error = ref('')
const result = ref<{ zoho_request_id?: string; vertrag?: string } | null>(null)

const definition = computed(() => contractByType(type.value))

const missing = computed(() =>
  definition.value.fields.filter((f) => f.required && !felder.value[f.name]?.trim()),
)

watch(type, (next) => {
  // Keep what both types share — switching from Dienstvertrag to freie
  // Mitarbeit should not clear the rates that were just typed.
  const fresh = draftFor(next)
  felder.value = Object.fromEntries(
    Object.entries(fresh).map(([key, value]) => [key, felder.value[key] || value]),
  )
  result.value = null
  error.value = ''
})

async function send() {
  if (missing.value.length) return
  busy.value = true
  error.value = ''
  try {
    result.value = await api.post<{ zoho_request_id?: string }>('/api/contracts/send', {
      vertrag: type.value,
      clientId: props.client.id,
      // Empty optionals stay out: the workflow fills in its own defaults, and
      // an empty string would overwrite them with nothing.
      felder: Object.fromEntries(
        Object.entries(felder.value).filter(([, value]) => value.trim() !== ''),
      ),
    })
    emit('sent')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKey))
onUnmounted(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-ink/25 p-6">
    <section class="w-full max-w-2xl border-2 border-ink bg-paper">
      <header class="flex items-center gap-3 border-b border-ink bg-acid px-5 py-3">
        <span class="eyebrow-muted !text-ink">Vertrag versenden</span>
        <span class="font-display text-sm font-semibold">
          {{ client.company || client.name }}
        </span>
        <button class="btn-xs ml-auto" @click="emit('close')">Schließen ✕</button>
      </header>

      <!-- Done: the one number worth keeping is the Zoho request id -->
      <div v-if="result" class="space-y-4 p-5">
        <p class="font-display text-lg font-semibold">{{ definition.title }} ist unterwegs.</p>
        <p class="text-sm text-soft">
          Zoho Sign hat die Unterschriftsanfrage an
          <span class="font-medium">{{ client.email }}</span> und an dich verschickt. Sobald beide
          unterschrieben haben, hakt sich die Aufgabe „Signatur ausstehend" von selbst ab und das
          signierte PDF landet beim Kunden.
        </p>
        <dl class="border-t border-line pt-3 text-sm">
          <div class="flex gap-3">
            <dt class="w-32 shrink-0 text-muted">Zoho-Request</dt>
            <dd class="font-mono">{{ result.zoho_request_id ?? '—' }}</dd>
          </div>
        </dl>
        <button class="btn-primary" @click="emit('close')">Fertig</button>
      </div>

      <form v-else class="space-y-5 p-5" @submit.prevent="send">
        <div>
          <label class="label">Vertragsart</label>
          <div class="flex flex-wrap gap-2">
            <button
              v-for="c in CONTRACTS"
              :key="c.type"
              type="button"
              class="border px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors"
              :class="
                type === c.type
                  ? 'border-ink bg-ink text-paper'
                  : 'border-line text-soft hover:border-ink'
              "
              @click="type = c.type"
            >
              {{ c.label }}
            </button>
          </div>
          <p class="mt-2 text-xs text-muted">{{ definition.title }}</p>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <label
            v-for="field in definition.fields"
            :key="field.name"
            class="label"
            :class="field.kind === 'area' ? 'sm:col-span-2' : ''"
          >
            {{ field.label }}
            <span v-if="!field.required" class="font-normal normal-case tracking-normal">
              (optional)
            </span>
            <textarea
              v-if="field.kind === 'area'"
              v-model="felder[field.name]"
              rows="3"
              class="input"
              :placeholder="field.placeholder"
            />
            <input
              v-else
              v-model="felder[field.name]"
              :type="field.kind === 'date' ? 'date' : 'text'"
              class="input"
              :placeholder="field.placeholder"
            />
            <span
              v-if="field.hint"
              class="mt-1 block text-xs font-normal normal-case tracking-normal text-muted"
            >
              {{ field.hint }}
            </span>
          </label>
        </div>

        <p v-if="!client.email" class="border-l-2 border-bad bg-bad/5 px-3 py-2 text-sm text-bad">
          {{ client.name }} hat keine E-Mail-Adresse — ohne sie kann Zoho Sign nichts zustellen.
        </p>
        <p v-if="error" class="border-l-2 border-bad bg-bad/5 px-3 py-2 text-sm text-bad">
          {{ error }}
        </p>

        <div class="flex items-center gap-3 border-t border-line pt-4">
          <button class="btn-acid" :disabled="busy || !client.email || missing.length > 0">
            {{ busy ? 'Erzeugt und verschickt …' : 'Erzeugen und versenden' }}
          </button>
          <span v-if="missing.length" class="text-xs text-muted">
            Es fehlt: {{ missing.map((f) => f.label).join(', ') }}
          </span>
          <span v-else-if="!busy" class="text-xs text-muted">
            Geht an {{ client.email }} und an dich.
          </span>
        </div>
      </form>
    </section>
  </div>
</template>
