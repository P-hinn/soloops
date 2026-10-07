<script setup lang="ts">
/**
 * Automatisierungen.
 *
 * Four tabs over one data load: the n8n canvas, the flows with their run
 * history, the template gallery, and everything that joins the two systems.
 * The tabs share a refresh because they share state — importing a template
 * changes the flow list, switching a workflow on creates a trigger.
 *
 * The one thing deliberately not reloaded on a timer is the builder: an
 * iframe that reloads under your hands while you drag a node is worse than
 * stale.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import AutomationBuilder from '@/components/automations/AutomationBuilder.vue'
import AutomationFlows from '@/components/automations/AutomationFlows.vue'
import AutomationTemplates from '@/components/automations/AutomationTemplates.vue'
import AutomationConnections from '@/components/automations/AutomationConnections.vue'
import type {
  AutomationFlow,
  AutomationStatus,
  AutomationTemplate,
  AutomationToken,
  AutomationTrigger,
} from '@/lib/automations'

type Tab = 'builder' | 'flows' | 'templates' | 'connections'

const TABS: { key: Tab; label: string }[] = [
  { key: 'builder', label: 'Builder' },
  { key: 'flows', label: 'Flows' },
  { key: 'templates', label: 'Vorlagen' },
  { key: 'connections', label: 'Verbindungen' },
]

const tab = ref<Tab>('flows')

const status = ref<AutomationStatus | null>(null)
const flows = ref<AutomationFlow[]>([])
const templates = ref<AutomationTemplate[]>([])
const triggers = ref<AutomationTrigger[]>([])
const tokens = ref<AutomationToken[]>([])
const baseUrl = ref('http://api:3000')
const projects = ref<{ id: string; key: string }[]>([])

const loading = ref(true)
const syncing = ref(false)
const error = ref('')

async function load() {
  error.value = ''
  try {
    // One round trip's worth of parallel calls. The status is the only one
    // that must succeed — the rest are empty when there is no API key, which
    // is a legitimate state rather than a failure.
    const [s, f, t, tr, tk] = await Promise.all([
      api.get<AutomationStatus>('/api/automations/status'),
      api.get<AutomationFlow[]>('/api/automations/flows'),
      api.get<AutomationTemplate[]>('/api/automations/templates'),
      api.get<AutomationTrigger[]>('/api/automations/triggers'),
      api.get<{ tokens: AutomationToken[]; baseUrl: string }>('/api/automations/tokens'),
    ])
    status.value = s
    flows.value = f
    templates.value = t
    triggers.value = tr
    tokens.value = tk.tokens
    baseUrl.value = tk.baseUrl
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    loading.value = false
  }
}

/** Pull from n8n now, rather than waiting for the worker's two-minute beat. */
async function syncNow() {
  syncing.value = true
  error.value = ''
  try {
    await api.post('/api/automations/sync')
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    syncing.value = false
  }
}

/**
 * While the monitoring is on screen, keep it current. Only there: the builder
 * must not be yanked about, and the other two change only when you act.
 */
let timer: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  projects.value = await api.get<{ id: string; key: string }[]>('/api/projects')
  await load()
  timer = setInterval(() => {
    if (tab.value === 'flows' && !syncing.value) load()
  }, 20_000)
})

onUnmounted(() => clearInterval(timer))

const failing = computed(() => status.value?.failing ?? 0)
</script>

<template>
  <!-- A column, so the builder tab can hand the iframe the remaining height -->
  <div class="flex min-h-[calc(100vh-7rem)] flex-col">
    <PageHeader title="Automatisierungen" subtitle="n8n, eingebaut in soloops">
      <template #actions>
        <span v-if="failing" class="badge badge-bad">{{ failing }} scheitern</span>
        <button class="btn-ghost" :disabled="syncing" @click="syncNow">
          {{ syncing ? 'Gleiche ab …' : 'Jetzt abgleichen' }}
        </button>
      </template>
    </PageHeader>

    <!-- Tabs -->
    <div class="mb-6 flex gap-1 border-b border-line">
      <button
        v-for="item in TABS"
        :key="item.key"
        class="relative px-3 py-2 text-[13px] transition-colors hover:text-ink"
        :class="tab === item.key ? 'font-medium text-ink' : 'text-soft'"
        @click="tab = item.key"
      >
        {{ item.label }}
        <span v-if="tab === item.key" class="absolute inset-x-0 -bottom-px h-[2px] bg-acid" />
        <span
          v-if="item.key === 'flows' && failing"
          class="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-bad align-middle"
        />
      </button>
    </div>

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>
    <p v-if="loading" class="py-10 text-center text-sm text-muted">Lade …</p>

    <template v-else-if="status">
      <AutomationBuilder
        v-if="tab === 'builder'"
        :src="status.editorUrl"
        :reachable="status.reachable"
      />

      <AutomationFlows
        v-else-if="tab === 'flows'"
        :flows="flows"
        :projects="projects"
        :authorized="status.authorized"
        @changed="load"
      />

      <AutomationTemplates
        v-else-if="tab === 'templates'"
        :templates="templates"
        :projects="projects"
        :authorized="status.authorized"
        @changed="load"
      />

      <AutomationConnections
        v-else
        :status="status"
        :triggers="triggers"
        :tokens="tokens"
        :base-url="baseUrl"
        @changed="load"
      />
    </template>
  </div>
</template>
