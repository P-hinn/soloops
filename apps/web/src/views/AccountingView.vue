<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api'
import { formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

type Revenue = {
  year: number
  months: { month: number; netCents: number; taxCents: number; grossCents: number; count: number }[]
  totalNetCents: number
  totalTaxCents: number
  totalGrossCents: number
}
type Status = {
  provider: string
  connected: boolean
  pending?: number
  error?: string
  profile?: { companyName: string; taxType: string }
}

const revenue = ref<Revenue | null>(null)
const status = ref<Status | null>(null)
const year = ref(new Date().getFullYear())
const busy = ref(false)
const message = ref('')

const monthNames = [
  'Jan',
  'Feb',
  'Mär',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez',
]

const maxGross = computed(() =>
  Math.max(1, ...(revenue.value?.months.map((m) => m.grossCents) ?? [1])),
)

async function load() {
  ;[revenue.value, status.value] = await Promise.all([
    api.get<Revenue>('/api/accounting/revenue', { year: year.value }),
    api.get<Status>('/api/accounting/status'),
  ])
}

async function syncPending() {
  busy.value = true
  message.value = ''
  try {
    const res = await api.post<{
      synced: number
      results: { number: string; ok: boolean; error?: string }[]
    }>('/api/accounting/invoices/sync-pending')
    message.value = `${res.synced} übertragen. ${res.results
      .filter((r) => !r.ok)
      .map((r) => `${r.number}: ${r.error}`)
      .join(' | ')}`
    await load()
  } catch (err) {
    message.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader title="Buchhaltung" subtitle="Umsatz und lexoffice-Anbindung">
      <template #actions>
        <select v-model.number="year" class="input w-28" @change="load">
          <option v-for="y in [year + 1, year, year - 1, year - 2]" :key="y" :value="y">
            {{ y }}
          </option>
        </select>
        <button
          class="btn-primary"
          :disabled="busy || !status?.connected || !status?.pending"
          @click="syncPending"
        >
          {{ status?.pending ? `${status.pending} → lexoffice` : 'Nichts offen' }}
        </button>
      </template>
    </PageHeader>

    <div
      class="card mb-4 flex items-center gap-3"
      :class="status?.connected ? 'border-ink' : 'border-line'"
    >
      <span class="badge" :class="status?.connected ? 'badge-good' : ''"> lexoffice </span>
      <span v-if="status?.connected" class="text-sm">
        Verbunden mit <strong>{{ status.profile?.companyName }}</strong>
        <span class="text-muted"> · Steuerart {{ status.profile?.taxType }}</span>
      </span>
      <span v-else class="text-sm text-muted">
        Nicht verbunden{{ status?.error ? ` — ${status.error}` : ' (LEXOFFICE_API_KEY setzen)' }}
      </span>
    </div>

    <p v-if="message" class="mb-4 text-sm text-soft">{{ message }}</p>

    <div class="grid grid-cols-3 gap-3">
      <StatCard label="Netto" :value="formatMoney(revenue?.totalNetCents ?? 0)" />
      <StatCard
        label="Umsatzsteuer"
        :value="formatMoney(revenue?.totalTaxCents ?? 0)"
        tone="warn"
      />
      <StatCard label="Brutto" :value="formatMoney(revenue?.totalGrossCents ?? 0)" tone="good" />
    </div>

    <section class="card mt-4">
      <h2 class="eyebrow mb-4">Umsatz {{ revenue?.year }}</h2>
      <div class="flex h-48 items-end gap-2">
        <div
          v-for="m in revenue?.months ?? []"
          :key="m.month"
          class="flex flex-1 flex-col items-center gap-1"
        >
          <div class="flex w-full flex-1 items-end">
            <div
              class="w-full border border-ink transition-colors hover:bg-acid"
              :class="m.grossCents > 0 ? 'bg-ink' : 'bg-transparent'"
              :style="{ height: `${Math.max(1, (m.grossCents / maxGross) * 100)}%` }"
              :title="formatMoney(m.grossCents)"
            />
          </div>
          <span class="text-[10px] text-muted">{{ monthNames[m.month - 1] }}</span>
        </div>
      </div>

      <table class="table mt-6">
        <thead>
          <tr>
            <th>Monat</th>
            <th class="text-right">Rechnungen</th>
            <th class="text-right">Netto</th>
            <th class="text-right">USt</th>
            <th class="text-right">Brutto</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in (revenue?.months ?? []).filter((x) => x.count > 0)" :key="m.month">
            <td>{{ monthNames[m.month - 1] }}</td>
            <td class="text-right tabular-nums">{{ m.count }}</td>
            <td class="text-right tabular-nums">{{ formatMoney(m.netCents) }}</td>
            <td class="text-right tabular-nums">{{ formatMoney(m.taxCents) }}</td>
            <td class="text-right tabular-nums">{{ formatMoney(m.grossCents) }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
