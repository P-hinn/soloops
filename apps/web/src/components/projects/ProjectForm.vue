<script setup lang="ts">
/**
 * Creating a project and editing one — the same form.
 *
 * Used by the list and by the project page: a project could be created with a
 * key, a budget and a due date and then never be corrected again, which made
 * a typo in the key something you had to live with.
 *
 * It reads the project itself rather than taking it from the caller: the list
 * endpoint does not carry rate, budget and description, and a form filled from
 * it would send those back as null — editing the name would quietly wipe the
 * budget. It writes it itself too, so both callers only have to reload.
 */
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import {
  PROJECT_STATUSES,
  draftOf,
  emptyDraft,
  projectPayload,
  statusLabel,
  type ProjectFields,
} from '@/lib/projects'

type Client = { id: string; name: string; company: string | null }

/** No id means a new project. */
const props = defineProps<{ projectId?: string | null }>()
const emit = defineEmits<{ saved: [id: string]; cancel: [] }>()

const clients = ref<Client[]>([])
const draft = ref(emptyDraft())
const loading = ref(Boolean(props.projectId))
const error = ref('')
const busy = ref(false)

async function save() {
  error.value = ''
  busy.value = true
  try {
    const payload = projectPayload(draft.value)
    const saved = props.projectId
      ? await api.patch<{ id: string }>(`/api/projects/${props.projectId}`, payload)
      : await api.post<{ id: string }>('/api/projects', payload)
    emit('saved', saved.id)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

onMounted(async () => {
  try {
    const [list, project] = await Promise.all([
      api.get<Client[]>('/api/clients'),
      props.projectId
        ? api.get<ProjectFields>(`/api/projects/${props.projectId}`)
        : Promise.resolve(null),
    ])
    clients.value = list
    if (project) draft.value = draftOf(project)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <p v-if="loading" class="card text-sm text-muted">Lädt …</p>

  <form v-else class="card grid gap-3 md:grid-cols-4" @submit.prevent="save">
    <div>
      <label class="label" for="project-key">Kürzel</label>
      <input
        id="project-key"
        v-model="draft.key"
        class="input uppercase"
        placeholder="ACME-DWH"
        required
      />
    </div>
    <div class="md:col-span-2">
      <label class="label" for="project-name">Name</label>
      <input id="project-name" v-model="draft.name" class="input" required />
    </div>
    <div>
      <label class="label" for="project-client">Kunde</label>
      <select id="project-client" v-model="draft.clientId" class="input">
        <option value="">Intern</option>
        <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.company ?? c.name }}</option>
      </select>
    </div>

    <div>
      <label class="label" for="project-status">Status</label>
      <select id="project-status" v-model="draft.status" class="input">
        <option v-for="s in PROJECT_STATUSES" :key="s" :value="s">{{ statusLabel(s) }}</option>
      </select>
    </div>
    <div>
      <label class="label" for="project-starts">Start</label>
      <input id="project-starts" v-model="draft.startsOn" type="date" class="input" />
    </div>
    <div>
      <label class="label" for="project-due">Deadline</label>
      <input id="project-due" v-model="draft.dueOn" type="date" class="input" />
    </div>
    <div>
      <label class="label" for="project-color">Farbe</label>
      <input
        id="project-color"
        v-model="draft.color"
        type="color"
        class="h-9 w-full rounded border border-line bg-paper"
      />
    </div>

    <div>
      <label class="label" for="project-rate">Stundensatz (€)</label>
      <input
        id="project-rate"
        v-model="draft.hourlyRate"
        class="input tabular-nums"
        inputmode="decimal"
        placeholder="Kunde / Default"
      />
    </div>
    <div>
      <label class="label" for="project-budget">Budget (€)</label>
      <input
        id="project-budget"
        v-model="draft.budget"
        class="input tabular-nums"
        inputmode="decimal"
        placeholder="offen"
      />
    </div>

    <div class="md:col-span-4">
      <label class="label" for="project-description">Beschreibung (Markdown)</label>
      <textarea id="project-description" v-model="draft.description" rows="4" class="input" />
    </div>

    <p v-if="error" class="text-sm text-bad md:col-span-4">{{ error }}</p>

    <div class="flex items-end justify-end gap-2 md:col-span-4">
      <button type="button" class="btn-ghost" @click="emit('cancel')">Abbrechen</button>
      <button class="btn-primary" :disabled="busy">
        {{ busy ? 'Speichert …' : props.projectId ? 'Speichern' : 'Anlegen' }}
      </button>
    </div>
  </form>
</template>
