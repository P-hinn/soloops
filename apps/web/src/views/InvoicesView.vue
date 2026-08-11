<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { api } from '@/api'
import { formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'

type Invoice = {
  id: string
  number: string
  status: string
  issueDate: string
  dueDate: string
  totalCents: number
  lexofficeId: string | null
  client: { id: string; name: string; company: string | null }
  project?: { key: string } | null
}
type Client = { id: string; name: string }

const router = useRouter()
const invoices = ref<Invoice[]>([])
const clients = ref<Client[]>([])
const openCents = ref(0)
const paidCents = ref(0)
const error = ref('')
const showDraft = ref(false)

const today = new Date()
const draft = ref({
  clientId: '',
  from: new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().slice(0, 10),
  to: new Date(today.getFullYear(), today.getMonth(), 0).toISOString().slice(0, 10),
  groupByProject: true,
})

const statusTone: Record<string, string> = {
  DRAFT: '',
  SENT: 'badge-blue',
  PAID: 'badge-good',
  OVERDUE: 'badge-bad',
  CANCELLED: '',
}

const statusLabel: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'gestellt',
  PAID: 'bezahlt',
  OVERDUE: 'überfällig',
  CANCELLED: 'storniert',
}

async function load() {
  const res = await api.get<{ invoices: Invoice[]; openCents: number; paidCents: number }>(
    '/api/invoices',
  )
  invoices.value = res.invoices
  openCents.value = res.openCents
  paidCents.value = res.paidCents
}

async function createFromTime() {
  error.value = ''
  try {
    const created = await api.post<{ id: string }>('/api/invoices/from-time', {
      clientId: draft.value.clientId,
      from: new Date(draft.value.from).toISOString(),
      to: new Date(`${draft.value.to}T23:59:59`).toISOString(),
      groupByProject: draft.value.groupByProject,
    })
    router.push(`/invoices/${created.id}`)
  } catch (err) {
    error.value = (err as Error).message
  }
}

onMounted(async () => {
  clients.value = await api.get<Client[]>('/api/clients')
  await load()
})
</script>

<template>
  <div>
    <PageHeader title="Rechnungen">
      <template #actions>
        <button class="btn-primary" @click="showDraft = !showDraft">Aus Zeiten erstellen</button>
      </template>
    </PageHeader>

    <form v-if="showDraft" class="card mb-4 grid gap-3 md:grid-cols-4" @submit.prevent="createFromTime">
      <div>
        <label class="label">Kunde</label>
        <select v-model="draft.clientId" class="input" required>
          <option value="" disabled>wählen …</option>
          <option v-for="c in clients" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <div>
        <label class="label">Leistung von</label>
        <input v-model="draft.from" type="date" class="input" required />
      </div>
      <div>
        <label class="label">bis</label>
        <input v-model="draft.to" type="date" class="input" required />
      </div>
      <div class="flex items-end gap-3">
        <label class="flex items-center gap-2 text-sm">
          <input v-model="draft.groupByProject" type="checkbox" class="accent-ink" />
          pro Projekt
        </label>
        <button class="btn-primary">Entwurf</button>
      </div>
      <p v-if="error" class="md:col-span-4 text-sm text-bad">{{ error }}</p>
    </form>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatCard label="Offen" :value="formatMoney(openCents)" tone="warn" />
      <StatCard label="Bezahlt" :value="formatMoney(paidCents)" tone="good" />
      <StatCard label="Rechnungen" :value="String(invoices.length)" />
      <StatCard
        label="Entwürfe"
        :value="String(invoices.filter((i) => i.status === 'DRAFT').length)"
      />
    </div>

    <div class="mt-6 border-t border-line-strong">
      <table class="table">
        <thead>
          <tr>
            <th>Nummer</th>
            <th>Kunde</th>
            <th>Datum</th>
            <th>Fällig</th>
            <th>Status</th>
            <th>lexoffice</th>
            <th class="text-right">Betrag</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="i in invoices" :key="i.id" class="hover:bg-ink/[0.035]">
            <td>
              <RouterLink :to="`/invoices/${i.id}`" class="font-mono text-xs hover:text-blue">
                {{ i.number }}
              </RouterLink>
            </td>
            <td>{{ i.client.company ?? i.client.name }}</td>
            <td class="text-xs text-muted">{{ new Date(i.issueDate).toLocaleDateString('de-DE') }}</td>
            <td class="text-xs text-muted">{{ new Date(i.dueDate).toLocaleDateString('de-DE') }}</td>
            <td><span class="badge" :class="statusTone[i.status]">{{ statusLabel[i.status] ?? i.status }}</span></td>
            <td>
              <span v-if="i.lexofficeId" class="text-xs text-good">✓</span>
              <span v-else class="text-xs text-muted">—</span>
            </td>
            <td class="text-right tabular-nums">{{ formatMoney(i.totalCents) }}</td>
          </tr>
          <tr v-if="!invoices.length">
            <td colspan="7" class="py-8 text-center text-muted">Noch keine Rechnungen.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
