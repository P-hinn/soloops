<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import { formatMoney } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import { useAuth } from '@/stores/auth'

type Client = {
  id: string
  name: string
  company: string | null
  email: string | null
  phone: string | null
  street: string | null
  zip: string | null
  city: string | null
  vatId: string | null
  hourlyRateCents: number | null
  paymentTermDays: number
  lexofficeContactId: string | null
  archived: boolean
  _count: { projects: number; invoices: number }
}

const auth = useAuth()
const clients = ref<Client[]>([])
const showForm = ref(false)
const error = ref('')
const form = ref({
  id: '' as string | undefined,
  name: '',
  company: '',
  email: '',
  phone: '',
  street: '',
  zip: '',
  city: '',
  vatId: '',
  hourlyRate: '',
  paymentTermDays: 14,
})

async function load() {
  clients.value = await api.get<Client[]>('/api/clients')
}

function newClient() {
  showForm.value = true
  form.value = {
    id: undefined,
    name: '',
    company: '',
    email: '',
    phone: '',
    street: '',
    zip: '',
    city: '',
    vatId: '',
    hourlyRate: String((auth.config?.defaultHourlyRateCents ?? 0) / 100),
    paymentTermDays: 14,
  }
}

function edit(client: Client) {
  showForm.value = true
  form.value = {
    id: client.id,
    name: client.name,
    company: client.company ?? '',
    email: client.email ?? '',
    phone: client.phone ?? '',
    street: client.street ?? '',
    zip: client.zip ?? '',
    city: client.city ?? '',
    vatId: client.vatId ?? '',
    hourlyRate: client.hourlyRateCents ? String(client.hourlyRateCents / 100) : '',
    paymentTermDays: client.paymentTermDays,
  }
}

async function save() {
  error.value = ''
  const payload = {
    name: form.value.name,
    company: form.value.company || null,
    email: form.value.email || null,
    phone: form.value.phone || null,
    street: form.value.street || null,
    zip: form.value.zip || null,
    city: form.value.city || null,
    vatId: form.value.vatId || null,
    hourlyRateCents: form.value.hourlyRate ? Math.round(Number(form.value.hourlyRate) * 100) : null,
    paymentTermDays: Number(form.value.paymentTermDays),
  }
  try {
    if (form.value.id) await api.patch(`/api/clients/${form.value.id}`, payload)
    else await api.post('/api/clients', payload)
    showForm.value = false
    await load()
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function syncLexoffice(client: Client) {
  error.value = ''
  try {
    await api.post(`/api/accounting/clients/${client.id}/sync`)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  }
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader title="Kunden">
      <template #actions>
        <button class="btn-primary" @click="newClient">Neuer Kunde</button>
      </template>
    </PageHeader>

    <form v-if="showForm" class="card mb-4 grid gap-3 md:grid-cols-4" @submit.prevent="save">
      <div>
        <label class="label">Name / Ansprechpartner</label>
        <input v-model="form.name" class="input" required />
      </div>
      <div>
        <label class="label">Firma</label>
        <input v-model="form.company" class="input" />
      </div>
      <div>
        <label class="label">E-Mail</label>
        <input v-model="form.email" type="email" class="input" />
      </div>
      <div>
        <label class="label">Telefon</label>
        <input v-model="form.phone" class="input" />
      </div>
      <div class="md:col-span-2">
        <label class="label">Straße</label>
        <input v-model="form.street" class="input" />
      </div>
      <div>
        <label class="label">PLZ</label>
        <input v-model="form.zip" class="input" />
      </div>
      <div>
        <label class="label">Ort</label>
        <input v-model="form.city" class="input" />
      </div>
      <div>
        <label class="label">USt-IdNr.</label>
        <input v-model="form.vatId" class="input" />
      </div>
      <div>
        <label class="label">Stundensatz (€)</label>
        <input v-model="form.hourlyRate" type="number" step="0.01" class="input" />
      </div>
      <div>
        <label class="label">Zahlungsziel (Tage)</label>
        <input v-model="form.paymentTermDays" type="number" class="input" />
      </div>
      <div class="flex items-end gap-2">
        <button type="button" class="btn-ghost" @click="showForm = false">Abbrechen</button>
        <button class="btn-primary">Speichern</button>
      </div>
    </form>

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>

    <div class="border-t border-line-strong">
      <table class="table">
        <thead>
          <tr>
            <th>Kunde</th>
            <th>Kontakt</th>
            <th class="text-right">Satz</th>
            <th class="text-right">Projekte</th>
            <th class="text-right">Rechnungen</th>
            <th>lexoffice</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in clients" :key="c.id" class="hover:bg-ink/[0.035]">
            <td>
              <div>{{ c.company ?? c.name }}</div>
              <div v-if="c.company" class="text-xs text-muted">{{ c.name }}</div>
            </td>
            <td class="text-xs text-soft">
              {{ c.email ?? '—' }}<br />{{ [c.zip, c.city].filter(Boolean).join(' ') }}
            </td>
            <td class="text-right tabular-nums">
              {{ c.hourlyRateCents ? formatMoney(c.hourlyRateCents) : '—' }}
            </td>
            <td class="text-right tabular-nums">{{ c._count.projects }}</td>
            <td class="text-right tabular-nums">{{ c._count.invoices }}</td>
            <td>
              <span v-if="c.lexofficeContactId" class="text-xs text-good">✓</span>
              <button
                v-else-if="auth.config?.features.lexoffice"
                class="text-xs text-blue hover:underline"
                @click="syncLexoffice(c)"
              >
                anlegen
              </button>
              <span v-else class="text-xs text-muted">—</span>
            </td>
            <td class="text-right">
              <button class="btn-xs" @click="edit(c)">✎</button>
            </td>
          </tr>
          <tr v-if="!clients.length">
            <td colspan="7" class="py-8 text-center text-muted">Noch keine Kunden.</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
