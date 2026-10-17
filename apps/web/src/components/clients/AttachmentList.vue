<script setup lang="ts">
/**
 * The files filed at one client.
 *
 * The counterpart to the contract list: a contract is a document soloops
 * knows something about and can generate itself, a file here is whatever
 * arrived — the briefing, the logo, the scan of the signed protocol, the
 * subcontractor's invoice. Several at once, by picking them or by dropping
 * them on the panel, because that is how a mail attachment gets filed.
 *
 * Lives inside the customer row for the same reason the contacts and the
 * contracts do: a file without the customer it belongs to is a file nobody
 * finds again.
 */
import { computed, onMounted, ref } from 'vue'
import { ATTACHMENT_MAX_BYTES, downloadName, formatBytes, isInlineSafe } from '@soloops/shared'
import { api, getToken } from '@/api'

type Attachment = {
  id: string
  clientId: string
  title: string
  file: string
  originalName: string
  mime: string
  sizeBytes: number
  notes: string | null
  createdAt: string
  project: { id: string; key: string; name: string } | null
}

type Project = { id: string; key: string; name: string; clientId: string | null }

const props = defineProps<{ clientId: string }>()
const emit = defineEmits<{ changed: [] }>()

const files = ref<Attachment[]>([])
/** The customer's projects, for the one field that is a reference. */
const projects = ref<Project[]>([])
const error = ref('')
/** The id being worked on, 'upload' while files are going up, '' otherwise. */
const busy = ref('')
/** The file being renamed, or null. */
const editing = ref<string | null>(null)
const form = ref({ title: '', projectId: '', notes: '' })
const dragging = ref(false)

const date = (value: string) => new Date(value).toLocaleDateString('de-DE', { dateStyle: 'medium' })

/**
 * The line under the name.
 *
 * Built here rather than in the template: every part of it is conditional,
 * and a template that joins conditionals with separators prints a leading dot
 * on the one file that has neither project nor note.
 */
const rows = computed(() =>
  files.value.map((file) => {
    const meta = [formatBytes(file.sizeBytes), date(file.createdAt)]
    // Only when it says something the title does not — which it stops doing
    // as soon as somebody renames the file.
    if (file.originalName !== file.title) meta.push(file.originalName)
    if (file.project) meta.push(file.project.key)
    return { ...file, meta, inline: isInlineSafe(file.mime) }
  }),
)

async function load() {
  files.value = await api.get<Attachment[]>('/api/attachments', { clientId: props.clientId })
}

/**
 * Once, when a file is first renamed.
 *
 * Not on mount: most visits only read the list, and a second request per
 * unfolded customer row buys nothing for them.
 */
async function loadProjects() {
  if (projects.value.length) return
  const all = await api.get<Project[]>('/api/projects')
  projects.value = all.filter((project) => project.clientId === props.clientId)
}

function pick(event: Event) {
  const input = event.target as HTMLInputElement
  void send(Array.from(input.files ?? []))
  // So picking the same file twice in a row fires `change` the second time.
  input.value = ''
}

function onDrop(event: DragEvent) {
  dragging.value = false
  void send(Array.from(event.dataTransfer?.files ?? []))
}

/**
 * Upload, one request per file.
 *
 * Sequentially rather than all at once: the files are large, the limit is
 * generous, and a browser that opens eight uploads in parallel makes the
 * first one finish last. The list is reloaded once at the end.
 *
 * A file that is refused stops the rest — whoever dropped twenty files wants
 * to read the reason once, not twenty times.
 */
async function send(picked: File[]) {
  if (!picked.length) return
  error.value = ''
  busy.value = 'upload'
  try {
    for (const file of picked) {
      if (file.size === 0) throw new Error(`${file.name} ist leer`)
      if (file.size > ATTACHMENT_MAX_BYTES) {
        throw new Error(
          `${file.name} ist ${formatBytes(file.size)} groß — mehr als ${formatBytes(ATTACHMENT_MAX_BYTES)} nimmt soloops nicht`,
        )
      }
      await upload(file)
    }
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
    await load()
    emit('changed')
  }
}

/**
 * The bytes go up as the request body, not as a form.
 *
 * One file, the rest in the query string — so `fetch` with the bytes and the
 * file's own content type is the whole upload, and the API needs no multipart
 * parser. Same shape as the contract upload.
 */
async function upload(file: File) {
  const query = new URLSearchParams({ clientId: props.clientId, name: file.name })
  const res = await fetch(`/api/attachments?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken() ?? ''}`,
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  })
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(detail?.error ?? `${file.name} nicht hochgeladen (${res.status})`)
  }
}

/**
 * Open the file.
 *
 * Fetched with the token in the header and handed to the browser as a blob,
 * rather than linked with the token in the query: a URL ends up in history,
 * in the proxy log and in whatever it gets pasted into.
 *
 * What the API will not render in place — anything that could run a script
 * from this origin — is saved instead of opened, which is the same decision
 * `isInlineSafe` makes on the other side.
 */
async function open(file: Attachment) {
  error.value = ''
  busy.value = file.id
  try {
    const res = await fetch(`/api/attachments/${file.id}/file`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(detail?.error ?? `Datei nicht abrufbar (${res.status})`)
    }
    const url = URL.createObjectURL(await res.blob())
    if (isInlineSafe(file.mime)) {
      window.open(url, '_blank', 'noopener')
    } else {
      const link = document.createElement('a')
      link.href = url
      link.download = downloadName(file.title, file.originalName)
      link.click()
    }
    // The object stays alive until the new tab or the download has it; a
    // minute is plenty and keeps the blob from living for the rest of the
    // session.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

function startEdit(file: Attachment) {
  editing.value = file.id
  void loadProjects()
  form.value = {
    title: file.title,
    projectId: file.project?.id ?? '',
    notes: file.notes ?? '',
  }
}

async function save() {
  if (!editing.value) return
  error.value = ''
  busy.value = 'save'
  try {
    await api.patch(`/api/attachments/${editing.value}`, {
      title: form.value.title,
      projectId: form.value.projectId || null,
      notes: form.value.notes || null,
    })
    editing.value = null
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

/** Deleting, not archiving: the row says nothing the file does not. */
async function remove(file: Attachment) {
  if (!confirm(`„${file.title}" löschen? Die Datei wird aus der Ablage entfernt.`)) return
  error.value = ''
  busy.value = file.id
  try {
    await api.del(`/api/attachments/${file.id}`)
    await load()
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div
    class="px-3 py-2"
    :class="{ 'bg-blue/5 outline-dashed outline-1 outline-blue/40': dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="onDrop"
  >
    <div class="mb-2 flex items-center justify-between">
      <span class="eyebrow">Dateien</span>
      <label class="btn-xs cursor-pointer">
        + Datei anhängen
        <input type="file" multiple class="hidden" @change="pick" />
      </label>
    </div>

    <p v-if="error" class="mb-2 text-xs text-bad">{{ error }}</p>
    <p v-if="busy === 'upload'" class="mb-2 text-xs text-muted">Wird hochgeladen …</p>

    <ul class="divide-y divide-line">
      <li v-for="f in rows" :key="f.id" class="flex items-baseline gap-2 py-1.5 text-sm">
        <span class="flex-1">
          {{ f.title }}
          <span class="block text-xs text-soft">{{ f.meta.join(' · ') }}</span>
          <span v-if="f.notes" class="block text-xs text-muted">{{ f.notes }}</span>
        </span>

        <button
          class="btn-xs"
          :disabled="busy === f.id"
          :title="f.inline ? 'Öffnen' : 'Herunterladen'"
          @click="open(f)"
        >
          {{ f.inline ? 'Öffnen' : '↓' }}
        </button>
        <button class="btn-xs" title="Umbenennen" @click="startEdit(f)">✎</button>
        <button class="btn-xs" title="Löschen" :disabled="busy === f.id" @click="remove(f)">
          ×
        </button>
      </li>
      <li v-if="!rows.length && busy !== 'upload'" class="py-2 text-xs text-muted">
        Noch keine Datei angehängt — hierher ziehen geht auch.
      </li>
    </ul>

    <form v-if="editing !== null" class="mt-2 grid gap-2 md:grid-cols-4" @submit.prevent="save">
      <input v-model="form.title" class="input md:col-span-2" placeholder="Name" required />
      <label class="sr-only" :for="`datei-projekt-${clientId}`">Projekt</label>
      <select :id="`datei-projekt-${clientId}`" v-model="form.projectId" class="input">
        <option value="">— kein Projekt —</option>
        <option v-for="project in projects" :key="project.id" :value="project.id">
          {{ project.key }} · {{ project.name }}
        </option>
      </select>
      <input v-model="form.notes" class="input" placeholder="Notiz" />
      <div class="flex items-end gap-2 md:col-span-4">
        <button type="button" class="btn-ghost" @click="editing = null">Abbrechen</button>
        <button class="btn-primary" :disabled="busy === 'save'">Speichern</button>
      </div>
    </form>
  </div>
</template>
