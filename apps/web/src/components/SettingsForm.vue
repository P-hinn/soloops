<script setup lang="ts">
/**
 * Configuration that used to live only in the `.env`.
 *
 * One component for every group, because they behave the same: a value, the
 * note whether it still comes from the `.env` or has been overridden here,
 * and for a secret only "set" plus its first characters — the API never sends
 * one back.
 *
 * The note matters. Once a field has an answer in the database, editing the
 * `.env` has no effect any more, and somebody who does not know that edits
 * the file and waits for something to happen.
 */
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api'

type Field = {
  value: unknown
  label: string
  source: 'db' | 'env'
  secret: boolean
}
type Settings = Record<string, Field>

const props = defineProps<{
  /** Key prefix of the group, e.g. `company.` */
  group: string
  title: string
  /** Shown above the fields. */
  note?: string
}>()

const emit = defineEmits<{ saved: [] }>()

const all = ref<Settings>({})
const draft = ref<Record<string, unknown>>({})
const busy = ref(false)
const error = ref('')
const done = ref('')

const fields = computed(() =>
  Object.entries(all.value)
    .filter(([key]) => key.startsWith(props.group))
    .map(([key, field]) => ({ key, ...field })),
)

/** Has anything in this group been answered here rather than in the file? */
const overridden = computed(() => fields.value.some((field) => field.source === 'db'))

async function load() {
  all.value = await api.get<Settings>('/api/settings')
  draft.value = {}
}

function current(key: string): unknown {
  if (key in draft.value) return draft.value[key]
  const field = all.value[key]
  if (!field) return ''
  // A secret is never sent back, so its input starts empty and an empty
  // input means "leave it alone".
  if (field.secret) return ''
  return field.value ?? ''
}

function set(key: string, value: unknown) {
  draft.value[key] = value
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

function kind(field: { key: string; value: unknown; secret: boolean }): string {
  if (field.secret) return 'password'
  if (typeof field.value === 'boolean') return 'checkbox'
  if (typeof field.value === 'number') return 'number'
  return 'text'
}

function secretHint(field: Field): string {
  const value = field.value as { set?: boolean; hint?: string } | undefined
  if (!value?.set) return 'nicht gesetzt'
  return `gesetzt (${value.hint})`
}

onMounted(load)
</script>

<template>
  <section class="card mb-4">
    <h2 class="mb-1 text-sm font-semibold">{{ title }}</h2>
    <p v-if="note" class="mb-3 text-xs text-muted">{{ note }}</p>
    <p v-if="overridden" class="mb-3 text-xs text-soft">
      Hier gesetzte Werte gewinnen über die <code class="rounded bg-paper-2 px-1">.env</code> —
      Änderungen an der Datei wirken dann nicht mehr.
    </p>

    <div class="grid gap-3 md:grid-cols-3">
      <div v-for="field in fields" :key="field.key">
        <label :for="`set-${field.key}`" class="label flex items-center gap-2">
          {{ field.label }}
          <span v-if="field.source === 'db'" class="badge bg-blue/10 text-blue" title="Hier gesetzt"
            >hier</span
          >
          <span v-else class="badge bg-paper-2 text-muted" title="Kommt aus der .env">.env</span>
        </label>

        <label v-if="kind(field) === 'checkbox'" class="flex items-center gap-2 py-1">
          <input
            :id="`set-${field.key}`"
            type="checkbox"
            :checked="!!current(field.key)"
            @change="set(field.key, ($event.target as HTMLInputElement).checked)"
          />
          <span class="text-xs text-soft">{{ current(field.key) ? 'ja' : 'nein' }}</span>
        </label>

        <template v-else>
          <input
            :id="`set-${field.key}`"
            class="input"
            :type="kind(field)"
            :value="current(field.key)"
            :placeholder="field.secret ? secretHint(field) : ''"
            :step="kind(field) === 'number' ? 'any' : undefined"
            @input="
              set(
                field.key,
                kind(field) === 'number'
                  ? Number(($event.target as HTMLInputElement).value)
                  : ($event.target as HTMLInputElement).value,
              )
            "
          />
          <button
            v-if="field.source === 'db'"
            class="mt-1 text-xs text-muted hover:text-ink hover:underline"
            :disabled="busy"
            @click="reset(field.key)"
          >
            zurück zur .env
          </button>
        </template>
      </div>
    </div>

    <div class="mt-3 flex items-center gap-3">
      <button class="btn-primary" :disabled="busy" @click="save">Speichern</button>
      <span v-if="done" class="text-xs text-good">{{ done }}</span>
      <span v-if="error" class="text-xs text-bad">{{ error }}</span>
    </div>
  </section>
</template>
