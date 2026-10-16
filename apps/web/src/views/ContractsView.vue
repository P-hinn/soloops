<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import {
  CONTRACT_STATE_LABELS,
  CONTRACT_TYPE_LABELS,
  contractDaysLeft,
  contractState,
} from '@soloops/shared'
import { api, getToken } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

/**
 * Every contract, across all customers.
 *
 * The per-customer list is the one used while working — this page answers the
 * two questions that span customers: what is still waiting for a signature,
 * and what runs out soon. Filing and editing happens at the customer, which
 * is why there is nothing to edit here.
 */

type Contract = {
  id: string
  clientId: string
  type: string
  title: string
  status: string
  file: string | null
  externalId: string | null
  signedOn: string | null
  endsOn: string | null
  createdAt: string
  client: { id: string; name: string; company: string | null } | null
  task: { id: string; title: string; dueOn: string | null; done: boolean } | null
}

const contracts = ref<Contract[]>([])
const loading = ref(true)
const error = ref('')
const filter = ref<'alle' | 'offen' | 'laufend' | 'ablaufend'>('alle')

const now = new Date()

const rows = computed(() =>
  contracts.value.map((contract) => {
    const state = contractState(contract, now)
    return {
      ...contract,
      state,
      label: CONTRACT_STATE_LABELS[state],
      left: contractDaysLeft(contract.endsOn, now),
      typeLabel:
        CONTRACT_TYPE_LABELS[contract.type as keyof typeof CONTRACT_TYPE_LABELS] ?? contract.type,
    }
  }),
)

const visible = computed(() =>
  rows.value.filter((row) =>
    filter.value === 'alle'
      ? true
      : filter.value === 'offen'
        ? row.state === 'versendet' || row.state === 'entwurf'
        : filter.value === 'laufend'
          ? row.state === 'laeuft' || row.state === 'laeuft-ab'
          : row.state === 'laeuft-ab' || row.state === 'abgelaufen',
  ),
)

const stats = computed(() => ({
  open: rows.value.filter((r) => r.state === 'versendet').length,
  running: rows.value.filter((r) => r.state === 'laeuft' || r.state === 'laeuft-ab').length,
  expiring: rows.value.filter((r) => r.state === 'laeuft-ab' || r.state === 'abgelaufen').length,
}))

const date = (value: string | null) =>
  value
    ? new Date(value).toLocaleDateString('de-DE', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
      })
    : '—'

/**
 * Open the PDF.
 *
 * Fetched with the token in the header and handed to the browser as a blob,
 * rather than linked with the token in the query: a URL ends up in history,
 * in the proxy log and in whatever the user pastes it into.
 */
const opening = ref('')
async function openPdf(id: string) {
  opening.value = id
  try {
    const res = await fetch(`/api/contracts/${id}/file`, {
      headers: { Authorization: `Bearer ${getToken() ?? ''}` },
    })
    if (!res.ok) {
      const detail = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(detail?.error ?? `PDF nicht abrufbar (${res.status})`)
    }
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
  contracts.value = await api.get<Contract[]>('/api/contracts')
  loading.value = false
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader
      eyebrow="Abrechnen"
      title="Verträge"
      subtitle="Was auf eine Unterschrift wartet, was läuft — und was demnächst ausläuft."
    >
      <template #actions>
        <RouterLink to="/clients" class="btn-primary">Beim Kunden ablegen ↗</RouterLink>
      </template>
    </PageHeader>

    <div class="tile-grid mb-8 grid gap-6 sm:grid-cols-3">
      <StatCard
        label="Wartet auf Signatur"
        :value="String(stats.open)"
        hint="verschickt, noch nicht zurück"
        :tone="stats.open ? 'warn' : 'default'"
      />
      <StatCard label="Laufend" :value="String(stats.running)" hint="unterschrieben und gültig" />
      <StatCard
        label="Läuft aus"
        :value="String(stats.expiring)"
        hint="in den nächsten 30 Tagen oder schon vorbei"
        :tone="stats.expiring ? 'bad' : 'default'"
      />
    </div>

    <p v-if="error" class="mb-4 border-l-2 border-bad bg-bad/5 px-3 py-2 text-sm text-bad">
      {{ error }}
    </p>

    <div class="mb-4 flex gap-2">
      <button
        v-for="mode in ['alle', 'offen', 'laufend', 'ablaufend'] as const"
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
          <th class="w-24">Signiert</th>
          <th class="w-32">Läuft bis</th>
          <th class="w-24"></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in visible" :key="row.id">
          <td>
            <div class="font-medium">{{ row.title }}</div>
            <div class="text-xs text-muted">
              {{ row.typeLabel }}
              <span v-if="row.task && !row.task.done" class="text-warn">
                · offene Aufgabe, fällig {{ date(row.task.dueOn) }}
              </span>
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
                'badge-good': row.state === 'laeuft',
                'badge-warn': row.state === 'versendet' || row.state === 'laeuft-ab',
                'badge-bad': row.state === 'abgelehnt' || row.state === 'abgelaufen',
              }"
            >
              {{ row.label }}
            </span>
          </td>
          <td class="tabular-nums">{{ date(row.signedOn) }}</td>
          <td class="tabular-nums">
            {{ date(row.endsOn) }}
            <span v-if="row.left !== null && row.left >= 0" class="text-xs text-muted">
              ({{ row.left }} T)
            </span>
          </td>
          <td class="text-right">
            <button
              v-if="row.file"
              class="btn-xs"
              :disabled="opening === row.id"
              @click="openPdf(row.id)"
            >
              {{ opening === row.id ? '…' : 'PDF' }}
            </button>
          </td>
        </tr>
        <tr v-if="!visible.length">
          <td colspan="6" class="py-8 text-center text-sm text-muted">
            {{
              loading
                ? 'Lädt …'
                : 'Noch kein Vertrag abgelegt. Das geht beim Kunden über die Spalte „Verträge".'
            }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
