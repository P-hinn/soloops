<script setup lang="ts">
/**
 * The contracts filed at one client.
 *
 * Two kinds end up in the same list and that is the point: the ones soloops
 * generated and sent for signature, and the ones that arrived as a finished
 * PDF — a scanned NDA, the framework agreement from before soloops existed.
 * Filing the second kind is what this component is mostly for.
 *
 * Lives inside the customer row for the same reason the contacts do: a
 * contract without the customer it belongs to is not worth looking at.
 */
import { computed, onMounted, ref } from 'vue'
import {
  CONTRACT_STATE_LABELS,
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUSES,
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPES,
  contractDaysLeft,
  contractState,
} from '@soloops/shared'
import { api, getToken } from '@/api'

type Contract = {
  id: string
  clientId: string
  type: string
  title: string
  status: string
  file: string | null
  signedOn: string | null
  startsOn: string | null
  endsOn: string | null
  amountCents: number | null
  notes: string | null
  project: { id: string; key: string; name: string } | null
  task: { id: string; title: string; dueOn: string | null; done: boolean } | null
}

const props = defineProps<{ clientId: string }>()
const emit = defineEmits<{ changed: [] }>()

const contracts = ref<Contract[]>([])
const error = ref('')
const busy = ref('')
/** The contract being edited, or '' for the "new contract" row. */
const editing = ref<string | null>(null)
const form = ref(empty())
/** The PDF picked in the form, uploaded after the record exists. */
const picked = ref<File | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const types = CONTRACT_TYPES
const states = CONTRACT_STATUSES
const typeLabel = (type: string) =>
  CONTRACT_TYPE_LABELS[type as keyof typeof CONTRACT_TYPE_LABELS] ?? type

const now = new Date()

function empty() {
  return {
    type: 'nda' as string,
    title: '',
    status: 'signiert' as string,
    signedOn: '',
    startsOn: '',
    endsOn: '',
    amount: '',
    notes: '',
  }
}

/** The state as the overview shows it, plus how long it still runs. */
const rows = computed(() =>
  contracts.value.map((contract) => {
    const state = contractState(contract, now)
    const left = contractDaysLeft(contract.endsOn, now)
    return { ...contract, state, label: CONTRACT_STATE_LABELS[state], left }
  }),
)

async function load() {
  contracts.value = await api.get<Contract[]>('/api/contracts', { clientId: props.clientId })
}

function startNew() {
  editing.value = ''
  picked.value = null
  form.value = empty()
}

function startEdit(contract: Contract) {
  editing.value = contract.id
  picked.value = null
  form.value = {
    type: contract.type,
    title: contract.title,
    status: contract.status,
    signedOn: day(contract.signedOn),
    startsOn: day(contract.startsOn),
    endsOn: day(contract.endsOn),
    amount: contract.amountCents === null ? '' : (contract.amountCents / 100).toFixed(2),
    notes: contract.notes ?? '',
  }
}

/** `2026-10-16T00:00:00.000Z` as the date input wants it. */
function day(value: string | null): string {
  return value ? value.slice(0, 10) : ''
}

/** A date input gives a day; the API wants an instant. */
function instant(value: string): string | null {
  return value ? new Date(`${value}T00:00:00Z`).toISOString() : null
}

/** The title nobody wants to type: the type plus the year. */
function suggestTitle() {
  if (form.value.title.trim()) return
  form.value.title = `${typeLabel(form.value.type)} ${now.getFullYear()}`
}

function pick(event: Event) {
  picked.value = (event.target as HTMLInputElement).files?.[0] ?? null
}

async function save() {
  error.value = ''
  busy.value = 'save'
  const body = {
    type: form.value.type,
    title: form.value.title,
    status: form.value.status,
    signedOn: instant(form.value.signedOn),
    startsOn: instant(form.value.startsOn),
    endsOn: instant(form.value.endsOn),
    amountCents: form.value.amount
      ? Math.round(Number(form.value.amount.replace(',', '.')) * 100)
      : null,
    notes: form.value.notes || null,
  }
  try {
    const saved = editing.value
      ? await api.patch<Contract>(`/api/contracts/${editing.value}`, body)
      : await api.post<Contract>('/api/contracts', { ...body, clientId: props.clientId })
    if (picked.value) await upload(saved.id, picked.value)
    editing.value = null
    picked.value = null
    if (fileInput.value) fileInput.value.value = ''
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

/**
 * The PDF goes up as the request body, not as a form.
 *
 * One file, no fields beside it — so `fetch` with the bytes and the right
 * content type is the whole upload, and the API needs no multipart parser.
 */
async function upload(id: string, file: File) {
  const res = await fetch(`/api/contracts/${id}/file`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken() ?? ''}`,
      'Content-Type': 'application/pdf',
    },
    body: file,
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(detail?.error ?? `PDF nicht hochgeladen (${res.status})`)
  }
}

async function replaceFile(contract: Contract, event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''
  busy.value = contract.id
  try {
    await upload(contract.id, file)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

/**
 * Open the PDF.
 *
 * Fetched with the token in the header and handed to the browser as a blob,
 * rather than linked with the token in the query: a URL ends up in history,
 * in the proxy log and in whatever it gets pasted into.
 */
async function openPdf(contract: Contract) {
  error.value = ''
  busy.value = contract.id
  try {
    const res = await fetch(`/api/contracts/${contract.id}/file`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(detail?.error ?? `PDF nicht abrufbar (${res.status})`)
    }
    const blob = URL.createObjectURL(await res.blob())
    window.open(blob, '_blank', 'noopener')
    // The object stays alive until the new tab has it; a minute is plenty and
    // keeps the blob from living for the rest of the session.
    setTimeout(() => URL.revokeObjectURL(blob), 60_000)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

/** Archiving, not deleting: a contract is the kind of thing one keeps. */
async function archive(contract: Contract) {
  error.value = ''
  try {
    await api.patch(`/api/contracts/${contract.id}`, { archived: true })
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  }
}

const money = (cents: number) =>
  (cents / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })

const date = (value: string | null) =>
  value ? new Date(value).toLocaleDateString('de-DE', { dateStyle: 'medium' }) : ''

defineExpose({ startNew })
onMounted(load)
</script>

<template>
  <div class="px-3 py-2">
    <div class="mb-2 flex items-center justify-between">
      <span class="eyebrow">Verträge</span>
      <button class="btn-xs" @click="startNew">+ Vertrag ablegen</button>
    </div>

    <p v-if="error" class="mb-2 text-xs text-bad">{{ error }}</p>

    <ul class="divide-y divide-line">
      <li v-for="c in rows" :key="c.id" class="flex items-baseline gap-2 py-1.5 text-sm">
        <span class="flex-1">
          {{ c.title }}
          <span class="text-xs text-muted">· {{ typeLabel(c.type) }}</span>
          <span
            class="badge ml-1"
            :class="{
              'bg-good/10 text-good': c.state === 'laeuft',
              'bg-warn/10 text-warn': c.state === 'laeuft-ab' || c.state === 'versendet',
              'bg-bad/10 text-bad': c.state === 'abgelaufen' || c.state === 'abgelehnt',
              'bg-paper-2 text-muted': c.state === 'entwurf' || c.state === 'beendet',
            }"
          >
            {{ c.label }}
          </span>
          <span class="block text-xs text-soft">
            <template v-if="c.signedOn">unterschrieben {{ date(c.signedOn) }}</template>
            <template v-if="c.endsOn">
              · bis {{ date(c.endsOn) }}
              <template v-if="c.left !== null && c.left >= 0">({{ c.left }} Tage)</template>
            </template>
            <template v-if="c.amountCents"> · {{ money(c.amountCents) }}</template>
            <template v-if="c.project"> · {{ c.project.key }}</template>
            <template v-if="c.task && !c.task.done"> · Signatur ausstehend</template>
            <template v-if="!c.file"> · kein PDF</template>
          </span>
          <span v-if="c.notes" class="block text-xs text-muted">{{ c.notes }}</span>
        </span>

        <button
          v-if="c.file"
          class="btn-xs"
          :disabled="busy === c.id"
          title="PDF öffnen"
          @click="openPdf(c)"
        >
          PDF
        </button>
        <label class="btn-xs cursor-pointer" :title="c.file ? 'PDF ersetzen' : 'PDF hochladen'">
          {{ c.file ? '⇅' : '⇧' }}
          <input
            type="file"
            accept="application/pdf"
            class="hidden"
            @change="replaceFile(c, $event)"
          />
        </label>
        <button class="btn-xs" title="Bearbeiten" @click="startEdit(c)">✎</button>
        <button class="btn-xs" title="Archivieren" @click="archive(c)">×</button>
      </li>
      <li v-if="!rows.length && editing === null" class="py-2 text-xs text-muted">
        Noch kein Vertrag abgelegt.
      </li>
    </ul>

    <form v-if="editing !== null" class="mt-2 grid gap-2 md:grid-cols-4" @submit.prevent="save">
      <label class="sr-only" :for="`vertrag-art-${clientId}`">Art</label>
      <select
        :id="`vertrag-art-${clientId}`"
        v-model="form.type"
        class="input"
        @change="suggestTitle"
      >
        <option v-for="type in types" :key="type" :value="type">{{ typeLabel(type) }}</option>
      </select>
      <input
        v-model="form.title"
        class="input md:col-span-2"
        placeholder="Titel, z. B. NDA 2026"
        required
      />
      <label class="sr-only" :for="`vertrag-stand-${clientId}`">Stand</label>
      <select :id="`vertrag-stand-${clientId}`" v-model="form.status" class="input">
        <option v-for="state in states" :key="state" :value="state">
          {{ CONTRACT_STATUS_LABELS[state] }}
        </option>
      </select>

      <label class="label" :for="`vertrag-signiert-${clientId}`">
        Unterschrieben
        <input
          :id="`vertrag-signiert-${clientId}`"
          v-model="form.signedOn"
          type="date"
          class="input"
        />
      </label>
      <label class="label" :for="`vertrag-start-${clientId}`">
        Gilt ab
        <input
          :id="`vertrag-start-${clientId}`"
          v-model="form.startsOn"
          type="date"
          class="input"
        />
      </label>
      <label class="label" :for="`vertrag-ende-${clientId}`">
        Läuft bis
        <input :id="`vertrag-ende-${clientId}`" v-model="form.endsOn" type="date" class="input" />
      </label>
      <label class="label" :for="`vertrag-wert-${clientId}`">
        Wert (€)
        <input
          :id="`vertrag-wert-${clientId}`"
          v-model="form.amount"
          type="number"
          step="0.01"
          min="0"
          class="input"
        />
      </label>

      <input v-model="form.notes" class="input md:col-span-2" placeholder="Notiz" />
      <label class="label md:col-span-2" :for="`vertrag-pdf-${clientId}`">
        PDF
        <input
          :id="`vertrag-pdf-${clientId}`"
          ref="fileInput"
          type="file"
          accept="application/pdf"
          class="input"
          @change="pick"
        />
      </label>

      <div class="flex items-end gap-2 md:col-span-4">
        <button type="button" class="btn-ghost" @click="editing = null">Abbrechen</button>
        <button class="btn-primary" :disabled="busy === 'save'">Speichern</button>
        <span v-if="picked" class="self-center text-xs text-muted">{{ picked.name }}</span>
      </div>
    </form>
  </div>
</template>
