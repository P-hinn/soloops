<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import MarkdownBlock from '@/components/MarkdownBlock.vue'

type Note = {
  id: string
  title: string
  body: string
  tags: string[]
  pinned: boolean
  projectId: string | null
  updatedAt: string
  project?: { id: string; key: string; color: string } | null
}
type Project = { id: string; key: string; name: string }

const notes = ref<Note[]>([])
const projects = ref<Project[]>([])
const tags = ref<{ tag: string; count: number }[]>([])
const query = ref('')
const activeTag = ref('')
const selected = ref<Note | null>(null)
const editing = ref(false)
const draft = ref({ title: '', body: '', tags: '', projectId: '' })

async function load() {
  notes.value = await api.get<Note[]>('/api/notes', {
    q: query.value || undefined,
    tag: activeTag.value || undefined,
  })
  tags.value = await api.get<{ tag: string; count: number }[]>('/api/notes/tags')
}

let handle: ReturnType<typeof setTimeout> | null = null
watch([query, activeTag], () => {
  if (handle) clearTimeout(handle)
  handle = setTimeout(load, 250)
})

function open(note: Note) {
  selected.value = note
  editing.value = false
}

function newNote() {
  selected.value = null
  editing.value = true
  draft.value = { title: '', body: '', tags: '', projectId: '' }
}

function edit(note: Note) {
  selected.value = note
  editing.value = true
  draft.value = {
    title: note.title,
    body: note.body,
    tags: note.tags.join(', '),
    projectId: note.projectId ?? '',
  }
}

async function save() {
  const payload = {
    title: draft.value.title,
    body: draft.value.body,
    tags: draft.value.tags.split(',').map((t) => t.trim()).filter(Boolean),
    projectId: draft.value.projectId || null,
  }
  if (selected.value) await api.patch(`/api/notes/${selected.value.id}`, payload)
  else await api.post('/api/notes', payload)
  editing.value = false
  await load()
  if (!selected.value) selected.value = notes.value[0] ?? null
}

async function remove(note: Note) {
  if (!confirm(`"${note.title}" löschen?`)) return
  await api.del(`/api/notes/${note.id}`)
  selected.value = null
  await load()
}

onMounted(async () => {
  projects.value = await api.get<Project[]>('/api/projects')
  await load()
})
</script>

<template>
  <div>
    <PageHeader title="Notizen" :subtitle="`${notes.length} Einträge`">
      <template #actions>
        <button class="btn-primary" @click="newNote">Neue Notiz</button>
      </template>
    </PageHeader>

    <div class="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div class="space-y-3">
        <input v-model="query" class="input" placeholder="Volltextsuche …" />

        <div class="flex flex-wrap gap-1">
          <button
            class="badge"
            :class="activeTag === '' ? 'bg-indigo-950 text-indigo-400' : 'bg-zinc-800 text-zinc-400'"
            @click="activeTag = ''"
          >
            alle
          </button>
          <button
            v-for="t in tags"
            :key="t.tag"
            class="badge"
            :class="activeTag === t.tag ? 'bg-indigo-950 text-indigo-400' : 'bg-zinc-800 text-zinc-400'"
            @click="activeTag = t.tag"
          >
            {{ t.tag }} · {{ t.count }}
          </button>
        </div>

        <div class="card max-h-[70vh] space-y-1 overflow-y-auto p-2">
          <button
            v-for="n in notes"
            :key="n.id"
            class="block w-full rounded-lg px-3 py-2 text-left hover:bg-zinc-800"
            :class="selected?.id === n.id ? 'bg-zinc-800' : ''"
            @click="open(n)"
          >
            <div class="flex items-center gap-2">
              <span v-if="n.pinned" class="text-xs text-amber-400">★</span>
              <span class="truncate text-sm font-medium">{{ n.title }}</span>
            </div>
            <div class="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
              <span v-if="n.project">{{ n.project.key }}</span>
              <span>{{ new Date(n.updatedAt).toLocaleDateString('de-DE') }}</span>
            </div>
          </button>
          <p v-if="!notes.length" class="p-4 text-center text-sm text-zinc-600">Nichts gefunden.</p>
        </div>
      </div>

      <div class="card min-h-96">
        <template v-if="editing">
          <input v-model="draft.title" class="input mb-3" placeholder="Titel" />
          <textarea
            v-model="draft.body"
            rows="18"
            class="input font-mono text-xs"
            placeholder="Markdown …"
          />
          <div class="mt-3 grid gap-3 md:grid-cols-2">
            <div>
              <label class="label">Tags (kommagetrennt)</label>
              <input v-model="draft.tags" class="input" />
            </div>
            <div>
              <label class="label">Projekt</label>
              <select v-model="draft.projectId" class="input">
                <option value="">—</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
              </select>
            </div>
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <button class="btn-ghost" @click="editing = false">Abbrechen</button>
            <button class="btn-primary" @click="save">Speichern</button>
          </div>
        </template>

        <template v-else-if="selected">
          <div class="mb-3 flex items-start justify-between">
            <div>
              <h2 class="text-lg font-semibold">{{ selected.title }}</h2>
              <div class="mt-1 flex flex-wrap gap-1">
                <span v-for="t in selected.tags" :key="t" class="badge bg-zinc-800 text-zinc-400">
                  {{ t }}
                </span>
              </div>
            </div>
            <div class="flex gap-2">
              <button class="btn-ghost" @click="edit(selected)">Bearbeiten</button>
              <button class="btn-danger" @click="remove(selected)">Löschen</button>
            </div>
          </div>
          <MarkdownBlock :source="selected.body" />
        </template>

        <p v-else class="py-16 text-center text-sm text-zinc-600">
          Notiz links auswählen oder neue anlegen.
        </p>
      </div>
    </div>
  </div>
</template>
