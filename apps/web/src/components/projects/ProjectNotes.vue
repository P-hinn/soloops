<script setup lang="ts">
/**
 * The notes of one project, written where they are read.
 *
 * The project page used to list the titles and link to _Notizen_, where the
 * note then had to be found again and assigned to the project by hand — which
 * is why project notes stayed empty. Writing, editing and pinning happen here;
 * the notes page remains the place for search across all of them.
 */
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import MarkdownBlock from '@/components/MarkdownBlock.vue'

type Note = {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  updatedAt: string
}

const props = defineProps<{ projectId: string }>()

const notes = ref<Note[]>([])
const error = ref('')
/** The note being edited, `''` for the new one, null while nothing is open. */
const editing = ref<string | null>(null)
/** Which note is unfolded for reading — one at a time, bodies are long. */
const unfolded = ref<string | null>(null)
const busy = ref(false)
const form = ref({ title: '', body: '', tags: '', pinned: false })

async function load() {
  notes.value = await api.get<Note[]>('/api/notes', { projectId: props.projectId })
}

function startNew() {
  editing.value = ''
  form.value = { title: '', body: '', tags: '', pinned: false }
}

function startEdit(note: Note) {
  editing.value = note.id
  unfolded.value = note.id
  form.value = {
    title: note.title,
    body: note.body,
    tags: note.tags.join(', '),
    pinned: note.pinned,
  }
}

async function save() {
  error.value = ''
  busy.value = true
  const body = {
    title: form.value.title,
    body: form.value.body,
    tags: form.value.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    pinned: form.value.pinned,
    projectId: props.projectId,
  }
  try {
    if (editing.value) await api.patch(`/api/notes/${editing.value}`, body)
    else await api.post('/api/notes', body)
    editing.value = null
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function togglePin(note: Note) {
  error.value = ''
  try {
    await api.patch(`/api/notes/${note.id}`, { pinned: !note.pinned })
    await load()
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function remove(note: Note) {
  if (!confirm(`"${note.title}" löschen?`)) return
  error.value = ''
  try {
    await api.del(`/api/notes/${note.id}`)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  }
}

onMounted(load)
</script>

<template>
  <section class="card">
    <div class="mb-3 flex items-baseline justify-between">
      <h2 class="eyebrow">Notizen</h2>
      <button class="btn-xs" @click="startNew">+ Notiz</button>
    </div>

    <p v-if="error" class="mb-2 text-xs text-bad">{{ error }}</p>

    <ul class="divide-y divide-line">
      <li v-for="n in notes" :key="n.id" class="py-1.5 text-sm">
        <div class="flex items-baseline gap-2">
          <button
            class="flex-1 text-left hover:text-blue"
            @click="unfolded = unfolded === n.id ? null : n.id"
          >
            <span v-if="n.pinned" class="mr-1 text-xs text-warn">★</span>
            {{ n.title }}
            <span class="ml-1 text-xs tabular-nums text-muted">
              {{ new Date(n.updatedAt).toLocaleDateString('de-DE') }}
            </span>
          </button>
          <button
            class="btn-xs"
            :title="n.pinned ? 'Notiz nicht mehr anpinnen' : 'Notiz anpinnen'"
            @click="togglePin(n)"
          >
            ★
          </button>
          <button class="btn-xs" title="Notiz bearbeiten" @click="startEdit(n)">✎</button>
          <button class="btn-xs" title="Notiz löschen" @click="remove(n)">×</button>
        </div>
        <div v-if="unfolded === n.id && editing !== n.id" class="mt-2 border-l-2 border-line pl-3">
          <MarkdownBlock :source="n.body" />
          <div v-if="n.tags.length" class="mt-2 flex flex-wrap gap-1">
            <span v-for="t in n.tags" :key="t" class="badge bg-paper-2 text-soft">{{ t }}</span>
          </div>
        </div>
      </li>
      <li v-if="!notes.length && editing === null" class="py-2 text-xs text-muted">
        Noch keine Notiz zu diesem Projekt.
      </li>
    </ul>

    <form v-if="editing !== null" class="mt-3 space-y-2" @submit.prevent="save">
      <input v-model="form.title" class="input" placeholder="Titel" required />
      <textarea
        v-model="form.body"
        rows="8"
        class="input font-mono text-xs"
        placeholder="Markdown …"
      />
      <div class="flex flex-wrap items-center gap-3">
        <input v-model="form.tags" class="input flex-1" placeholder="Tags, kommagetrennt" />
        <label class="flex items-center gap-2 text-xs text-soft">
          <input v-model="form.pinned" type="checkbox" />
          angepinnt
        </label>
      </div>
      <div class="flex justify-end gap-2">
        <button type="button" class="btn-ghost" @click="editing = null">Abbrechen</button>
        <button class="btn-primary" :disabled="busy">
          {{ busy ? 'Speichert …' : 'Speichern' }}
        </button>
      </div>
    </form>
  </section>
</template>
