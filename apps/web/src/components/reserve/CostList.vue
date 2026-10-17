<script setup lang="ts">
/**
 * Die festen Geschäftskosten eines Jahres.
 *
 * Miete, Strom, Software, Versicherung — alles, was jeden Monat abgeht,
 * unabhängig davon, ob Umsatz kam. Die Summe zieht jeder Monat der Tabelle ab;
 * ein Jahr ohne Posten rechnet mit 0, nicht mit einer Pauschale.
 *
 * Jede Änderung antwortet mit dem neu gerechneten Jahr, damit Tabelle und
 * Jahressumme nicht nachgeladen werden müssen.
 */
import { ref } from 'vue'
import { api } from '@/api'
import { formatMoney } from '@soloops/shared'
import { centsToEuro, euroToCents } from '@/lib/money'
import type { ReserveCost, ReserveYearView } from '@/lib/reserve'

const props = defineProps<{ year: number; costs: ReserveCost[]; perMonthCents: number }>()
const emit = defineEmits<{ saved: [ReserveYearView] }>()

/** Der Posten in Arbeit, `''` für einen neuen, null solange nichts offen ist. */
const editing = ref<string | null>(null)
const form = ref({ label: '', amount: '', note: '' })
const error = ref('')
const busy = ref(false)

function startNew() {
  editing.value = ''
  form.value = { label: '', amount: '', note: '' }
}

function startEdit(cost: ReserveCost) {
  editing.value = cost.id
  form.value = {
    label: cost.label,
    amount: centsToEuro(cost.monthlyCents),
    note: cost.note ?? '',
  }
}

async function save() {
  error.value = ''
  busy.value = true
  const body = {
    label: form.value.label,
    monthlyCents: euroToCents(form.value.amount) ?? 0,
    note: form.value.note.trim() || null,
  }
  try {
    const year = editing.value
      ? await api.patch<ReserveYearView>(`/api/reserve/costs/${editing.value}`, body)
      : await api.post<ReserveYearView>(`/api/reserve/${props.year}/costs`, body)
    editing.value = null
    emit('saved', year)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function remove(cost: ReserveCost) {
  if (!confirm(`"${cost.label}" löschen?`)) return
  error.value = ''
  try {
    emit('saved', await api.del<ReserveYearView>(`/api/reserve/costs/${cost.id}`))
  } catch (err) {
    error.value = (err as Error).message
  }
}
</script>

<template>
  <section class="card">
    <div class="mb-3 flex items-baseline justify-between">
      <h2 class="eyebrow">Geschäftskosten je Monat</h2>
      <button class="btn-xs" @click="startNew">+ Posten</button>
    </div>

    <p v-if="error" class="mb-2 text-xs text-bad">{{ error }}</p>

    <ul class="divide-y divide-line">
      <li v-for="c in costs" :key="c.id" class="flex items-baseline gap-2 py-1.5 text-sm">
        <span class="flex-1">
          {{ c.label }}
          <span v-if="c.note" class="block text-xs text-muted">{{ c.note }}</span>
        </span>
        <span class="tabular-nums">{{ formatMoney(c.monthlyCents) }}</span>
        <button class="btn-xs" title="Posten bearbeiten" @click="startEdit(c)">✎</button>
        <button class="btn-xs" title="Posten löschen" @click="remove(c)">×</button>
      </li>
      <li v-if="!costs.length && editing === null" class="py-2 text-xs text-muted">
        Noch keine Kosten hinterlegt — gerechnet wird dann mit 0 €.
      </li>
    </ul>

    <p class="mt-3 flex items-baseline justify-between border-t border-line-strong pt-2 text-sm">
      <span class="text-muted">Summe je Monat</span>
      <span class="font-semibold tabular-nums">{{ formatMoney(perMonthCents) }}</span>
    </p>

    <form v-if="editing !== null" class="mt-3 grid gap-2 md:grid-cols-2" @submit.prevent="save">
      <input v-model="form.label" class="input" placeholder="Posten, z. B. Büro" required />
      <input
        v-model="form.amount"
        class="input tabular-nums"
        inputmode="decimal"
        placeholder="Betrag je Monat (€)"
      />
      <input v-model="form.note" class="input md:col-span-2" placeholder="Notiz (optional)" />
      <div class="flex justify-end gap-2 md:col-span-2">
        <button type="button" class="btn-ghost" @click="editing = null">Abbrechen</button>
        <button class="btn-primary" :disabled="busy">
          {{ busy ? 'Speichert …' : 'Speichern' }}
        </button>
      </div>
    </form>
  </section>
</template>
