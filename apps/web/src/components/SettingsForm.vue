<script setup lang="ts">
/**
 * Configuration that used to live only in the `.env`.
 *
 * How each field is offered comes from the registry in `@soloops/core`, not
 * from this component: that a rate is stored in cents, that a tax rate is a
 * percentage and that an interval is something to pick rather than to write
 * is part of what the value means. Here is only the rendering of it.
 *
 * Two things every field carries. **Where it comes from** — once the database
 * has an answer, editing the `.env` stops having an effect, and somebody who
 * does not know that edits the file and waits. And **whether it is needed**,
 * because four of the sender fields are what makes an invoice formally
 * complete, and that is worth marking rather than explaining.
 */
import { computed, onMounted, ref } from 'vue'
import { CRON_PRESETS, cronLabel } from '@soloops/shared'
import { api } from '@/api'

type Field = {
  value: unknown
  label: string
  source: 'db' | 'env'
  secret: boolean
  kind: string
  hint?: string
  required: boolean
  options?: { value: string; label: string }[]
}
type Settings = Record<string, Field>

const props = defineProps<{
  /** Key prefix of the group, e.g. `company.` */
  group: string
  title: string
  /** Shown above the fields. */
  note?: string
  /** Narrower groups read better in one column. */
  columns?: 1 | 2 | 3
}>()

const emit = defineEmits<{ saved: [] }>()

const all = ref<Settings>({})
const draft = ref<Record<string, unknown>>({})
/** Keys whose interval is typed by hand rather than picked. */
const custom = ref<Set<string>>(new Set())
const busy = ref(false)
const error = ref('')
const done = ref('')

const fields = computed(() =>
  Object.entries(all.value)
    .filter(([key]) => key.startsWith(props.group))
    .map(([key, field]) => ({ key, ...field })),
)

const gridClass = computed(
  () =>
    ({ 1: 'grid gap-4', 2: 'grid gap-4 md:grid-cols-2', 3: 'grid gap-4 md:grid-cols-3' })[
      props.columns ?? 3
    ],
)

const missing = computed(() =>
  fields.value.filter((field) => field.required && !String(field.value ?? '').trim()),
)

const changed = computed(() => Object.keys(draft.value).length > 0)

async function load() {
  all.value = await api.get<Settings>('/api/settings')
  draft.value = {}
  custom.value = new Set(
    Object.entries(all.value)
      .filter(([, f]) => f.kind === 'cron' && !cronLabel(String(f.value ?? '')))
      .map(([key]) => key),
  )
}

/**
 * What belongs in the input right now.
 *
 * Money is stored in cents and shown in euros — nobody types cents. A secret
 * is never sent back, so its field starts empty and empty means "leave it".
 */
function shown(field: { key: string; value: unknown; kind: string; secret: boolean }): unknown {
  if (field.key in draft.value) return draft.value[field.key]
  if (field.secret) return ''
  if (field.kind === 'money') return ((Number(field.value ?? 0) / 100) as number).toFixed(2)
  return field.value ?? ''
}

function edit(field: { key: string; kind: string }, raw: string | boolean) {
  if (typeof raw === 'boolean') {
    draft.value[field.key] = raw
    return
  }
  if (field.kind === 'money') {
    // Euros in, cents stored. Rounded, because 49.99 € must not become 4998.
    draft.value[field.key] = Math.round(Number(raw.replace(',', '.')) * 100)
    return
  }
  if (field.kind === 'percent' || field.kind === 'days') {
    draft.value[field.key] = Number(raw)
    return
  }
  draft.value[field.key] = raw
}

function pickInterval(key: string, value: string) {
  if (value === '__custom') {
    custom.value = new Set([...custom.value, key])
    return
  }
  custom.value = new Set([...custom.value].filter((entry) => entry !== key))
  draft.value[key] = value
}

/** The option a cron field currently shows. */
function intervalValue(field: { key: string; value: unknown }): string {
  const current = String(draft.value[field.key] ?? field.value ?? '')
  return cronLabel(current) ? current : '__custom'
}

function secretHint(field: Field): string {
  const value = field.value as { set?: boolean; hint?: string } | undefined
  return value?.set ? `gesetzt (${value.hint}) — leer lassen, um es zu behalten` : 'nicht gesetzt'
}

async function save() {
  error.value = ''
  done.value = ''
  busy.value = true
  try {
    const body: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(draft.value)) {
      // An untouched secret field must not clear the stored one.
      if (all.value[key]?.secret && value === '') continue
      body[key] = value
    }
    if (Object.keys(body).length === 0) {
      done.value = 'Nichts geändert'
      return
    }
    all.value = await api.patch<Settings>('/api/settings', body)
    draft.value = {}
    done.value = 'Gespeichert'
    emit('saved')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

/** Hand a field back to the `.env` by clearing it. */
async function reset(key: string) {
  error.value = ''
  busy.value = true
  try {
    all.value = await api.patch<Settings>('/api/settings', { [key]: null })
    delete draft.value[key]
    done.value = 'Wieder aus der .env'
    emit('saved')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <section class="card mb-4">
    <header class="mb-3">
      <h2 class="text-sm font-semibold">{{ title }}</h2>
      <p v-if="note" class="mt-1 text-xs text-muted">{{ note }}</p>
      <p v-if="missing.length" class="mt-2 text-xs text-bad">
        Fehlt noch für eine vollständige Rechnung:
        {{ missing.map((f) => f.label).join(', ') }}
      </p>
    </header>

    <div :class="gridClass">
      <div v-for="field in fields" :key="field.key">
        <label :for="`set-${field.key}`" class="label flex items-baseline gap-1.5">
          <span>{{ field.label }}</span>
          <span v-if="field.required" class="text-bad" title="Für eine Rechnung nötig">*</span>
          <span v-if="field.source === 'db'" class="badge bg-blue/10 text-blue" title="Hier gesetzt"
            >hier</span
          >
        </label>

        <!-- An interval is picked, not written. The free-text field is the
             exception and has to be asked for. -->
        <template v-if="field.kind === 'cron'">
          <select
            :id="`set-${field.key}`"
            class="input"
            :value="intervalValue(field)"
            @change="pickInterval(field.key, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="preset in CRON_PRESETS" :key="preset.value" :value="preset.value">
              {{ preset.label }}
            </option>
            <option value="__custom">eigener Cron-Ausdruck …</option>
          </select>
          <input
            v-if="custom.has(field.key)"
            class="input mt-1 font-mono text-xs"
            :value="shown(field)"
            placeholder="*/10 * * * *"
            aria-label="Cron-Ausdruck"
            @input="edit(field, ($event.target as HTMLInputElement).value)"
          />
        </template>

        <select
          v-else-if="field.kind === 'select'"
          :id="`set-${field.key}`"
          class="input"
          :value="shown(field)"
          @change="edit(field, ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="option in field.options ?? []" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>

        <label
          v-else-if="field.kind === 'switch'"
          class="flex items-center gap-2 py-1"
          :for="`set-${field.key}`"
        >
          <input
            :id="`set-${field.key}`"
            type="checkbox"
            :checked="!!shown(field)"
            @change="edit(field, ($event.target as HTMLInputElement).checked)"
          />
          <span class="text-xs text-soft">{{ shown(field) ? 'ja' : 'nein' }}</span>
        </label>

        <!-- A unit belongs next to the number, not in the label. -->
        <div v-else class="flex items-stretch">
          <input
            :id="`set-${field.key}`"
            class="input"
            :class="{
              'rounded-r-none': ['money', 'percent', 'days'].includes(field.kind),
              'font-mono': field.kind === 'iban' || field.kind === 'url',
            }"
            :type="
              field.secret
                ? 'password'
                : ['money', 'percent', 'days'].includes(field.kind)
                  ? 'number'
                  : 'text'
            "
            :inputmode="field.kind === 'money' ? 'decimal' : undefined"
            :step="field.kind === 'money' ? '0.01' : field.kind === 'percent' ? '0.1' : '1'"
            :min="['money', 'percent', 'days'].includes(field.kind) ? '0' : undefined"
            :value="shown(field)"
            :placeholder="field.secret ? secretHint(field) : ''"
            :autocomplete="field.secret ? 'new-password' : 'off'"
            @input="edit(field, ($event.target as HTMLInputElement).value)"
          />
          <span
            v-if="['money', 'percent', 'days'].includes(field.kind)"
            class="flex items-center rounded-r border border-l-0 border-line-strong bg-paper-2 px-2 text-xs text-muted"
          >
            {{ { money: '€', percent: '%', days: 'Tage' }[field.kind] }}
          </span>
        </div>

        <p v-if="field.hint" class="mt-1 text-xs text-muted">{{ field.hint }}</p>
        <button
          v-if="field.source === 'db'"
          class="mt-1 text-xs text-muted hover:text-ink hover:underline"
          :disabled="busy"
          @click="reset(field.key)"
        >
          zurück zur .env
        </button>
      </div>
    </div>

    <div class="mt-4 flex items-center gap-3 border-t border-line pt-3">
      <button class="btn-primary" :disabled="busy || !changed" @click="save">Speichern</button>
      <span v-if="done" class="text-xs text-good">{{ done }}</span>
      <span v-if="error" class="text-xs text-bad">{{ error }}</span>
      <span v-else-if="changed" class="text-xs text-muted">ungespeicherte Änderungen</span>
    </div>
  </section>
</template>
