<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, getToken } from '@/api'
import { formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import { useAuth } from '@/stores/auth'

type Invoice = {
  id: string
  number: string
  status: string
  issueDate: string
  dueDate: string
  currency: string
  subtotalCents: number
  taxRate: number
  taxCents: number
  totalCents: number
  smallBusiness: boolean
  intro: string | null
  notes: string | null
  lexofficeId: string | null
  lexofficeSyncedAt: string | null
  client: {
    id: string
    name: string
    company: string | null
    street: string | null
    zip: string | null
    city: string | null
  }
  project: { key: string; name: string } | null
  items: {
    id: string
    position: number
    description: string
    quantity: string
    unit: string
    unitPriceCents: number
    amountCents: number
  }[]
}

const route = useRoute()
const router = useRouter()
const auth = useAuth()
const invoice = ref<Invoice | null>(null)
const busy = ref(false)
const error = ref('')
const pdfUrl = ref('')

const statusLabel: Record<string, string> = {
  DRAFT: 'Entwurf',
  SENT: 'gestellt',
  PAID: 'bezahlt',
  OVERDUE: 'überfällig',
  CANCELLED: 'storniert',
}

async function load() {
  invoice.value = await api.get<Invoice>(`/api/invoices/${route.params.id}`)
}

async function setStatus(status: string) {
  busy.value = true
  try {
    await api.post(`/api/invoices/${route.params.id}/status`, { status })
    await load()
  } finally {
    busy.value = false
  }
}

async function syncLexoffice() {
  busy.value = true
  error.value = ''
  try {
    await api.post(`/api/accounting/invoices/${route.params.id}/sync`)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

/** The PDF needs the bearer token — so load it as a blob instead of linking. */
async function openPdf() {
  const res = await fetch(`/api/invoices/${route.params.id}/pdf`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  const blob = await res.blob()
  pdfUrl.value = URL.createObjectURL(blob)
  window.open(pdfUrl.value, '_blank')
}

async function remove() {
  if (!confirm('Entwurf löschen? Die verknüpften Zeiten werden wieder freigegeben.')) return
  await api.del(`/api/invoices/${route.params.id}`)
  router.push('/invoices')
}

onMounted(load)
</script>

<template>
  <div v-if="invoice">
    <PageHeader
      :title="`Rechnung ${invoice.number}`"
      :subtitle="`${invoice.client.company ?? invoice.client.name} · ${statusLabel[invoice.status] ?? invoice.status}`"
    >
      <template #actions>
        <button class="btn-ghost" @click="openPdf">PDF</button>
        <button
          v-if="invoice.status === 'DRAFT'"
          class="btn-primary"
          :disabled="busy"
          @click="setStatus('SENT')"
        >
          Als gestellt markieren
        </button>
        <button
          v-if="invoice.status === 'SENT' || invoice.status === 'OVERDUE'"
          class="btn-primary"
          :disabled="busy"
          @click="setStatus('PAID')"
        >
          Als bezahlt markieren
        </button>
        <button
          v-if="
            auth.config?.features.lexoffice && !invoice.lexofficeId && invoice.status !== 'DRAFT'
          "
          class="btn-ghost"
          :disabled="busy"
          @click="syncLexoffice"
        >
          → lexoffice
        </button>
        <button v-if="invoice.status === 'DRAFT'" class="btn-danger" @click="remove">
          Löschen
        </button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>
    <p v-if="invoice.lexofficeId" class="mb-4 text-sm text-good">
      An lexoffice übertragen ({{ new Date(invoice.lexofficeSyncedAt!).toLocaleString('de-DE') }})
    </p>

    <div class="grid gap-4 lg:grid-cols-[1fr_300px]">
      <div class="card">
        <p v-if="invoice.intro" class="mb-4 text-sm text-soft">{{ invoice.intro }}</p>

        <table class="table">
          <thead>
            <tr>
              <th class="w-8">Pos</th>
              <th>Beschreibung</th>
              <th class="text-right">Menge</th>
              <th class="text-right">Einzel</th>
              <th class="text-right">Betrag</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in invoice.items" :key="item.id">
              <td class="text-muted">{{ item.position }}</td>
              <td class="whitespace-pre-line">{{ item.description }}</td>
              <td class="text-right tabular-nums">{{ Number(item.quantity) }} {{ item.unit }}</td>
              <td class="text-right tabular-nums">
                {{ formatMoney(item.unitPriceCents, invoice.currency) }}
              </td>
              <td class="text-right tabular-nums">
                {{ formatMoney(item.amountCents, invoice.currency) }}
              </td>
            </tr>
          </tbody>
        </table>

        <div class="mt-4 ml-auto w-64 space-y-1 text-sm">
          <div class="flex justify-between">
            <span class="text-muted">Zwischensumme</span>
            <span class="tabular-nums">{{
              formatMoney(invoice.subtotalCents, invoice.currency)
            }}</span>
          </div>
          <div v-if="!invoice.smallBusiness" class="flex justify-between">
            <span class="text-muted">USt {{ invoice.taxRate }} %</span>
            <span class="tabular-nums">{{ formatMoney(invoice.taxCents, invoice.currency) }}</span>
          </div>
          <div class="flex justify-between border-t border-line pt-1 text-base font-semibold">
            <span>Gesamt</span>
            <span class="tabular-nums">{{
              formatMoney(invoice.totalCents, invoice.currency)
            }}</span>
          </div>
        </div>

        <p v-if="invoice.smallBusiness" class="mt-4 text-xs text-muted">
          Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.
        </p>
      </div>

      <div class="card h-fit">
        <h2 class="eyebrow mb-3">Details</h2>
        <dl class="space-y-2 text-sm">
          <div class="flex justify-between">
            <dt class="text-muted">Rechnungsdatum</dt>
            <dd>{{ new Date(invoice.issueDate).toLocaleDateString('de-DE') }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-muted">Fällig</dt>
            <dd>{{ new Date(invoice.dueDate).toLocaleDateString('de-DE') }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-muted">Projekt</dt>
            <dd>{{ invoice.project?.key ?? '—' }}</dd>
          </div>
        </dl>

        <h3 class="eyebrow-muted mt-5 mb-1.5">Empfänger</h3>
        <address class="text-sm not-italic text-soft">
          {{ invoice.client.company ?? invoice.client.name }}<br />
          <template v-if="invoice.client.street">{{ invoice.client.street }}<br /></template>
          {{ invoice.client.zip }} {{ invoice.client.city }}
        </address>
      </div>
    </div>
  </div>
</template>
