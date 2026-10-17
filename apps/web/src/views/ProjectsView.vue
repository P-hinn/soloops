<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '@/api'
import { formatDuration } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import ProjectForm from '@/components/projects/ProjectForm.vue'
import { statusLabel, statusTone, type ProjectFields } from '@/lib/projects'
import { useTimer } from '@/stores/timer'

type Project = ProjectFields & {
  id: string
  dueOn: string | null
  client?: { id: string; name: string; company: string | null } | null
  trackedSec: number
  unbilledSec: number
}

const timer = useTimer()
const projects = ref<Project[]>([])
/**
 * What the form is on: a project id, or `null` for a new one. Closed is
 * `undefined` — "new project" and "no form" are two different states.
 */
const editing = ref<string | null | undefined>(undefined)
/** The archive is its own view: the list otherwise fills up with dead projects. */
const archive = ref(false)

async function load() {
  projects.value = await api.get<Project[]>(
    '/api/projects',
    archive.value ? { status: 'ARCHIVED' } : undefined,
  )
}

async function toggleArchive() {
  archive.value = !archive.value
  editing.value = undefined
  await load()
}

async function saved() {
  editing.value = undefined
  await load()
}

async function startTimer(projectId: string) {
  await timer.start(projectId)
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader
      title="Projekte"
      :subtitle="archive ? `${projects.length} archiviert` : `${projects.length} Projekte`"
    >
      <template #actions>
        <button class="btn-ghost" @click="toggleArchive">
          {{ archive ? 'Aktive' : 'Archiv' }}
        </button>
        <button class="btn-primary" @click="editing = editing === null ? undefined : null">
          Neues Projekt
        </button>
      </template>
    </PageHeader>

    <!-- `key` so switching from one project to another rebuilds the draft
         instead of showing the previously edited one. -->
    <ProjectForm
      v-if="editing !== undefined"
      :key="editing ?? 'new'"
      class="mb-4"
      :project-id="editing"
      @saved="saved"
      @cancel="editing = undefined"
    />

    <div class="border-t border-line-strong">
      <table class="table">
        <thead>
          <tr>
            <th>Projekt</th>
            <th>Kunde</th>
            <th>Status</th>
            <th class="text-right">Erfasst</th>
            <th class="text-right">Offen</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in projects" :key="p.id" class="hover:bg-ink/[0.035]">
            <td>
              <RouterLink :to="`/projects/${p.id}`" class="flex items-center gap-2 hover:text-blue">
                <span class="h-2.5 w-2.5 rounded-full" :style="{ background: p.color }" />
                <span class="font-mono text-xs text-muted">{{ p.key }}</span>
                <span>{{ p.name }}</span>
              </RouterLink>
            </td>
            <td class="text-soft">{{ p.client?.company ?? p.client?.name ?? 'intern' }}</td>
            <td>
              <span class="badge" :class="statusTone(p.status)">{{ statusLabel(p.status) }}</span>
            </td>
            <td class="text-right tabular-nums">{{ formatDuration(p.trackedSec) }} h</td>
            <td
              class="text-right tabular-nums"
              :class="p.unbilledSec > 0 ? 'text-warn' : 'text-muted'"
            >
              {{ formatDuration(p.unbilledSec) }} h
            </td>
            <td class="text-right">
              <button class="btn-xs" title="Bearbeiten" @click="editing = p.id">✎</button>
              <button class="btn-xs ml-1" @click="startTimer(p.id)">▶ Timer</button>
            </td>
          </tr>
          <tr v-if="!projects.length">
            <td colspan="6" class="py-8 text-center text-muted">
              {{ archive ? 'Nichts archiviert.' : 'Noch keine Projekte.' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
