<script setup lang="ts">
/**
 * The people at one client: who to write to, who signs, who pays.
 *
 * Lives inside the customer row rather than on a page of its own — a contact
 * without the company it belongs to is not worth looking at, and the list is
 * short enough to edit in place.
 */
import { onMounted, ref } from 'vue'
import { api } from '@/api'

type Contact = {
  id: string
  clientId: string
  name: string
  role: string | null
  email: string | null
  phone: string | null
  notes: string | null
  primary: boolean
}

const props = defineProps<{ clientId: string }>()
const emit = defineEmits<{ changed: [] }>()

const contacts = ref<Contact[]>([])
const error = ref('')
/** The contact being edited, or '' for the "new person" row. */
const editing = ref<string | null>(null)
const form = ref({ name: '', role: '', email: '', phone: '', notes: '', primary: false })

async function load() {
  contacts.value = await api.get<Contact[]>('/api/contacts', { clientId: props.clientId })
}

function startNew() {
  editing.value = ''
  form.value = {
    name: '',
    role: '',
    email: '',
    phone: '',
    notes: '',
    primary: !contacts.value.length,
  }
}

function startEdit(contact: Contact) {
  editing.value = contact.id
  form.value = {
    name: contact.name,
    role: contact.role ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    notes: contact.notes ?? '',
    primary: contact.primary,
  }
}

async function save() {
  error.value = ''
  const body = {
    name: form.value.name,
    role: form.value.role || null,
    email: form.value.email || null,
    phone: form.value.phone || null,
    notes: form.value.notes || null,
    primary: form.value.primary,
  }
  try {
    if (editing.value) await api.patch(`/api/contacts/${editing.value}`, body)
    else await api.post('/api/contacts', { ...body, clientId: props.clientId })
    editing.value = null
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  }
}

/** Archiving, not deleting: the person may be on an old meeting or mail. */
async function archive(contact: Contact) {
  error.value = ''
  try {
    await api.patch(`/api/contacts/${contact.id}`, { archived: true })
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function makePrimary(contact: Contact) {
  error.value = ''
  try {
    await api.patch(`/api/contacts/${contact.id}`, { primary: true })
    await load()
  } catch (err) {
    error.value = (err as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div class="px-3 py-2">
    <div class="mb-2 flex items-center justify-between">
      <span class="text-xs font-semibold uppercase tracking-wider text-muted">
        Ansprechpartner
      </span>
      <button class="btn-xs" @click="startNew">+ Person</button>
    </div>

    <p v-if="error" class="mb-2 text-xs text-bad">{{ error }}</p>

    <ul class="divide-y divide-line">
      <li v-for="c in contacts" :key="c.id" class="flex items-baseline gap-2 py-1.5 text-sm">
        <span class="flex-1">
          {{ c.name }}
          <span v-if="c.role" class="text-xs text-muted">· {{ c.role }}</span>
          <span v-if="c.primary" class="ml-1 text-xs text-blue" title="Hauptansprechpartner"
            >★</span
          >
          <span v-if="c.email || c.phone" class="block text-xs text-soft">
            {{ [c.email, c.phone].filter(Boolean).join(' · ') }}
          </span>
        </span>
        <button
          v-if="!c.primary"
          class="btn-xs"
          title="Als Hauptansprechpartner"
          @click="makePrimary(c)"
        >
          ★
        </button>
        <button class="btn-xs" @click="startEdit(c)">✎</button>
        <button class="btn-xs" title="Archivieren" @click="archive(c)">×</button>
      </li>
      <li v-if="!contacts.length && editing === null" class="py-2 text-xs text-muted">
        Noch niemand hinterlegt.
      </li>
    </ul>

    <form v-if="editing !== null" class="mt-2 grid gap-2 md:grid-cols-4" @submit.prevent="save">
      <input v-model="form.name" class="input" placeholder="Name" required />
      <input v-model="form.role" class="input" placeholder="Funktion" />
      <input v-model="form.email" type="email" class="input" placeholder="E-Mail" />
      <input v-model="form.phone" class="input" placeholder="Telefon" />
      <input v-model="form.notes" class="input md:col-span-2" placeholder="Notiz" />
      <label class="flex items-center gap-2 text-xs text-soft">
        <input v-model="form.primary" type="checkbox" />
        Hauptansprechpartner
      </label>
      <div class="flex items-end gap-2">
        <button type="button" class="btn-ghost" @click="editing = null">Abbrechen</button>
        <button class="btn-primary">Speichern</button>
      </div>
    </form>
  </div>
</template>
