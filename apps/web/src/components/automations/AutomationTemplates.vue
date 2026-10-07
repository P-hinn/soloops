<script setup lang="ts">
/**
 * The template gallery.
 *
 * One click drops a finished workflow into n8n. It lands inactive on purpose:
 * a template cannot know which credential to use — n8n credentials live in
 * n8n — so the honest end of the import is "here it is, open it", and that is
 * what the button does.
 */
import { ref } from 'vue'
import { api } from '@/api'
import type { AutomationTemplate } from '@/lib/automations'

const props = defineProps<{
  templates: AutomationTemplate[]
  projects: { id: string; key: string }[]
  authorized: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const busy = ref('')
const error = ref('')
const projectId = ref('')
/** Where the freshly imported workflow lives, so the row can link to it. */
const imported = ref<Record<string, string>>({})

async function importTemplate(template: AutomationTemplate) {
  busy.value = template.slug
  error.value = ''
  try {
    const result = await api.post<{ editorUrl: string }>(
      `/api/automations/templates/${template.slug}/import`,
      { projectId: projectId.value || null },
    )
    imported.value[template.slug] = result.editorUrl
    emit('changed')
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

/** `n8n-nodes-soloops.soloops` reads better as just `soloops`. */
const shortNode = (type: string) => type.split('.').pop() ?? type
</script>

<template>
  <div>
    <div class="mb-5 flex flex-wrap items-end justify-between gap-4">
      <p class="max-w-2xl text-sm text-muted">
        Fertige Flows mit den soloops-Nodes. Sie landen inaktiv in n8n — Credential auswählen,
        prüfen, einschalten. Danach registriert sich der Trigger von allein und soloops schickt die
        Events.
      </p>
      <label class="label shrink-0">
        Projekt zuordnen
        <select v-model="projectId" class="input mt-1 py-1 text-xs">
          <option value="">—</option>
          <option v-for="p in props.projects" :key="p.id" :value="p.id">{{ p.key }}</option>
        </select>
      </label>
    </div>

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>
    <p v-if="!props.authorized" class="mb-4 text-sm text-warn">
      Ohne n8n-API-Key kann soloops keine Vorlage anlegen. Siehe „Verbindungen“.
    </p>

    <div class="grid gap-3 md:grid-cols-2">
      <div v-for="template in props.templates" :key="template.slug" class="card flex flex-col">
        <div class="flex items-start justify-between gap-3">
          <h3 class="font-display text-base font-semibold">{{ template.name }}</h3>
          <span v-if="template.installed" class="badge badge-good shrink-0">angelegt</span>
        </div>

        <p class="mt-2 flex-1 text-sm text-soft">{{ template.description }}</p>

        <div class="mt-3 flex flex-wrap items-center gap-1.5">
          <span v-if="template.event" class="badge badge-acid">{{ template.event }}</span>
          <span v-else class="badge bg-paper-2 text-muted">Zeitplan</span>
          <span
            v-for="node in template.nodes"
            :key="node"
            class="badge bg-paper-2 text-soft"
            :title="node"
          >
            {{ shortNode(node) }}
          </span>
        </div>

        <div class="mt-4 flex items-center gap-2 border-t border-line pt-3">
          <button
            class="btn-primary btn-xs"
            :disabled="busy === template.slug || !props.authorized"
            @click="importTemplate(template)"
          >
            {{ busy === template.slug ? 'Lege an …' : 'In n8n anlegen' }}
          </button>
          <a
            v-if="imported[template.slug]"
            class="btn-ghost btn-xs"
            :href="imported[template.slug]"
            target="_blank"
            rel="noopener"
          >
            Öffnen
          </a>
        </div>
      </div>
    </div>
  </div>
</template>
