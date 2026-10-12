<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api, getToken } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import { CONTRACT_STATUS_LABEL } from '@/lib/contracts'

/**
 * Who has which contract, in what state.
 *
 * Read out of the `[VERTRAG]` notes the workflows write — there is no
 * contracts table, see services/contracts.ts on the API side. The practical
 * consequence is visible here: a contract that was handled by hand shows up
 * too, as long as the note follows the convention.
 */

type ContractRow = {
  title: string
  status: 'versendet' | 'signiert' | 'abgelehnt'
  on: string | null
  sentOn: string | null
  zohoRequestId: string | null
  file: string | null
  noteId: string
  createdAt: string
  clientId: string | null
  client: { id: string; name: string; company: string | null } | null
  openTask: { id: string; title: string; dueOn: string | null } | null
}

const rows = ref<ContractRow[]>([])
const loading = ref(true)
const error = ref('')
const filter = ref<'alle' | 'offen' | 'signiert'>('alle')

const visible = computed(() =>
  rows.value.filter((row) =>
    filter.value === 'alle'
      ? true
      : filter.value === 'offen'
        ? row.status === 'versendet'
        : row.status === 'signiert',
  ),
)

const stats = computed(() => ({
  open: rows.value.filter((r) => r.status === 'versendet').length,
  signed: rows.value.filter((r) => r.status === 'signiert').length,
  overdue: rows.value.filter(
    (r) => r.status === 'versendet' && r.sentOn && daysSince(r.sentOn) > 14,
  ).length,
}))

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
}

const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      })
    : '—'

/**
 * Open the signed PDF.
 *
 * Fetched with the token in the header and handed to the browser as a blob,
 * rather than linked with the token in the query: a URL ends up in history,
 * in the proxy log and in whatever the user pastes it into.
 */
const opening = ref('')
async function openPdf(path: string) {
  opening.value = path
  try {
    const url = new URL('/api/contracts/file', window.location.origin)
    url.searchParams.set('path', path)
    const res = await fetch(url, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
    if (!res.ok) throw new Error(`PDF nicht abrufbar (${res.status})`)
    const blob = URL.createObjectURL(await res.blob())
    window.open(blob, '_blank', 'noopener')
    // The object stays alive until the new tab has it; a minute is plenty and
    // keeps the blob from living for the rest of the session.
    setTimeout(() => URL.revokeObjectURL(blob), 60_000)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    opening.value = ''
  }
}

async function load() {
  const res = await api.get<{ rows: ContractRow[] }>('/api/contracts')
  rows.value = res.rows
  loading.value = false
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Abrechnen"
      title="Verträge"
      subtitle="Was verschickt ist, was unterschrieben zurückkam — und was zu lange liegt."
    >
      <template #actions>
        <RouterLink to="/clients" class="btn-primary">Vertrag versenden ↗</RouterLink>
      </template>
    </PageHeader>

    <div class="tile-grid mb-8 grid gap-6 sm:grid-cols-3">
      <StatCard
        label="Wartet auf Signatur"
        :value="String(stats.open)"
        hint="verschickt, noch nicht zurück"
        :tone="stats.open ? 'warn' : 'default'"
      />
      <StatCard
        label="Über zwei Wochen offen"
        :value="String(stats.overdue)"
        hint="da lohnt ein Anruf"
        :tone="stats.overdue ? 'bad' : 'default'"
      />
      <StatCard label="Signiert" :value="String(stats.signed)" hint="beidseitig unterschrieben" />
    </div>

    <p v-if="error" class="mb-4 border-l-2 border-bad bg-bad/5 px-3 py-2 text-sm text-bad">
      {{ error }}
    </p>

    <div class="mb-4 flex gap-2">
      <button
        v-for="mode in ['alle', 'offen', 'signiert'] as const"
        :key="mode"
        class="border px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.09em] transition-colors"
        :class="
          filter === mode
            ? 'border-ink bg-ink text-paper'
            : 'border-line text-soft hover:border-ink'
        "
        @click="filter = mode"
      >
        {{ mode }}
      </button>
    </div>

    <table class="table">
      <thead>
        <tr>
          <th>Vertrag</th>
          <th>Kunde</th>
          <th class="w-28">Status</th>
          <th class="w-24">Verschickt</th>
          <th class="w-24">Signiert</th>
          <th class="w-32">Zoho</th>
          <th class="w-24"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visible" :key="row.noteId">
          <td>
            <div class="font-medium">{{ row.title }}</div>
            <div v-if="row.openTask" class="text-xs text-warn">
              offene Aufgabe · fällig {{ date(row.openTask.dueOn) }}
            </div>
          </td>
          <td>
            <RouterLink v-if="row.client" to="/clients" class="hover:text-blue">
              {{ row.client.company ?? row.client.name }}
            </RouterLink>
            <span v-else class="text-muted">—</span>
          </td>
          <td>
            <span
              class="badge"
              :class="{
                'badge-good': row.status === 'signiert',
                'badge-warn': row.status === 'versendet',
                'badge-bad': row.status === 'abgelehnt',
              }"
            >
              {{ CONTRACT_STATUS_LABEL[row.status] ?? row.status }}
            </span>
          </td>
          <td class="tabular-nums">{{ date(row.sentOn) }}</td>
          <td class="tabular-nums">
            {{ row.status === 'signiert' ? date(row.on) : '—' }}
          </td>
          <td class="truncate font-mono text-xs text-muted" :title="row.zohoRequestId ?? ''">
            {{ row.zohoRequestId ?? '—' }}
          </td>
          <td class="text-right">
            <button
              v-if="row.file"
              class="btn-xs"
              :disabled="opening === row.file"
              @click="openPdf(row.file)"
            >
              {{ opening === row.file ? '…' : 'PDF' }}
            </button>
          </td>
        </tr>
        <tr v-if="!visible.length">
          <td colspan="7" class="py-8 text-center text-sm text-muted">
            {{
              loading
                ? 'Lädt …'
                : 'Noch kein Vertrag verschickt. Das geht bei einem Kunden über „Vertrag".'
            }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
