<script setup lang="ts">
/**
 * Rücklage: was vom Monatsumsatz am Ende privat übrig bleibt.
 *
 * Die Seite rechnet beim Tippen mit derselben Formel, mit der die API später
 * speichert (reserveLine aus @soloops/shared) — man kann also einen Umsatz
 * ausprobieren, ohne ihn zu übernehmen. Geschrieben wird erst beim Verlassen
 * des Feldes, und dann nur die eine Zahl, die eingetippt wurde.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api'
import { formatMoney, reserveLine, sumReserveLines, type ReserveRates } from '@soloops/shared'
import PageHeader from '@/components/PageHeader.vue'
import StatCard from '@/components/StatCard.vue'
import CostList from '@/components/reserve/CostList.vue'
import { centsToEuro, euroToCents } from '@/lib/money'
import { monthName, reserveCsv, type ReserveMonthRow, type ReserveYearView } from '@/lib/reserve'

const view = ref<ReserveYearView | null>(null)
const years = ref<{ year: number; payoutCents: number }[]>([])
const year = ref(new Date().getFullYear())
const error = ref('')
const savingMonth = ref<number | null>(null)
const savingRates = ref(false)

/** Der Umsatz je Monat, wie er im Feld steht — in Euro, nicht in Cent. */
const gross = ref<Record<number, string>>({})
/** Die Sätze, wie sie im Formular stehen; die Tabelle rechnet mit diesen. */
const rates = ref<ReserveRates>({ vatRate: 19, incomeTaxRate: 35, discountRate: 0 })
const note = ref('')

const costPerMonthCents = computed(() => view.value?.costPerMonthCents ?? 0)

const grossCentsOf = (month: number) => euroToCents(gross.value[month] ?? '') ?? 0

const rows = computed<ReserveMonthRow[]>(() =>
  (view.value?.months ?? []).map((m) => ({
    month: m.month,
    note: m.note,
    invoicedGrossCents: m.invoicedGrossCents,
    ...reserveLine(grossCentsOf(m.month), costPerMonthCents.value, rates.value),
  })),
)

const total = computed(() => sumReserveLines(rows.value))

/** Was noch nicht gespeichert ist — der Punkt neben dem Feld. */
const monthDirty = (month: number) =>
  grossCentsOf(month) !== (view.value?.months.find((m) => m.month === month)?.grossCents ?? 0)

const ratesDirty = computed(() => {
  const stored = view.value?.rates
  if (!stored) return false
  return (
    stored.vatRate !== rates.value.vatRate ||
    stored.incomeTaxRate !== rates.value.incomeTaxRate ||
    stored.discountRate !== rates.value.discountRate ||
    (view.value?.note ?? '') !== note.value
  )
})

function apply(next: ReserveYearView) {
  view.value = next
  rates.value = { ...next.rates }
  note.value = next.note ?? ''
  gross.value = Object.fromEntries(
    next.months.map((m) => [m.month, m.grossCents ? centsToEuro(m.grossCents) : '']),
  )
}

async function load() {
  error.value = ''
  try {
    const [detail, list] = await Promise.all([
      api.get<ReserveYearView>(`/api/reserve/${year.value}`),
      api.get<{ year: number; payoutCents: number }[]>('/api/reserve'),
    ])
    apply(detail)
    years.value = list
  } catch (err) {
    error.value = (err as Error).message
  }
}

watch(year, load)

async function saveMonth(month: number) {
  if (!monthDirty(month)) return
  error.value = ''
  savingMonth.value = month
  try {
    apply(
      await api.put<ReserveYearView>(`/api/reserve/${year.value}/months/${month}`, {
        grossCents: grossCentsOf(month),
      }),
    )
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    savingMonth.value = null
  }
}

/** Den Vorschlag aus den Rechnungen übernehmen — ein Klick, dann gespeichert. */
async function adopt(row: ReserveMonthRow) {
  gross.value[row.month] = centsToEuro(row.invoicedGrossCents)
  await saveMonth(row.month)
}

async function saveRates() {
  error.value = ''
  savingRates.value = true
  try {
    apply(
      await api.patch<ReserveYearView>(`/api/reserve/${year.value}`, {
        ...rates.value,
        note: note.value.trim() || null,
      }),
    )
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    savingRates.value = false
  }
}

function downloadCsv() {
  const csv = reserveCsv(year.value, rates.value, rows.value, total.value)
  // Mit BOM, sonst liest Excel die Umlaute als Buchstabensalat.
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `ruecklage-${year.value}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

onMounted(load)
</script>

<template>
  <div>
    <PageHeader
      title="Rücklage"
      :subtitle="`Was vom Umsatz ${year} privat übrig bleibt`"
      eyebrow="Dokumentation"
    >
      <template #actions>
        <button class="btn-ghost" title="Vorjahr" @click="year -= 1">‹</button>
        <select v-model.number="year" class="input w-28" aria-label="Jahr">
          <option v-for="y in years" :key="y.year" :value="y.year">{{ y.year }}</option>
          <option v-if="!years.some((y) => y.year === year)" :value="year">{{ year }}</option>
        </select>
        <button class="btn-ghost" title="Folgejahr" @click="year += 1">›</button>
        <button class="btn-primary" @click="downloadCsv">CSV</button>
      </template>
    </PageHeader>

    <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>

    <div v-if="view">
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Umsatz brutto" :value="formatMoney(total.grossCents)" />
        <StatCard label="Umsatzsteuer" :value="formatMoney(total.vatCents)" tone="warn" />
        <StatCard label="Steuerrücklage" :value="formatMoney(total.reserveCents)" tone="warn" />
        <StatCard label="Auszahlung privat" :value="formatMoney(total.payoutCents)" />
      </div>

      <p v-if="!view.exists" class="mt-4 border-l-2 border-line-strong pl-3 text-sm text-muted">
        {{ year }} ist noch leer. Sätze und Kostenposten stehen so, wie sie zuletzt galten —
        gespeichert wird das Jahr, sobald du den ersten Umsatz einträgst.
      </p>

      <div class="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <section class="border-t border-line-strong">
          <table class="table">
            <thead>
              <tr>
                <th>Monat</th>
                <th class="text-right">Umsatz brutto</th>
                <th v-if="rates.discountRate > 0" class="text-right">Skonto</th>
                <th class="text-right">Umsatzsteuer</th>
                <th class="text-right">Netto</th>
                <th class="text-right">Rücklage</th>
                <th class="text-right">Kosten</th>
                <th class="text-right">Auszahlung</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.month" class="hover:bg-ink/[0.035]">
                <td class="whitespace-nowrap">
                  <label :for="`gross-${row.month}`">{{ monthName(row.month) }}</label>
                </td>
                <td class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <span
                      v-if="monthDirty(row.month)"
                      class="h-1.5 w-1.5 rounded-full bg-warn"
                      title="noch nicht gespeichert"
                    />
                    <input
                      :id="`gross-${row.month}`"
                      v-model="gross[row.month]"
                      class="input w-28 text-right tabular-nums"
                      inputmode="decimal"
                      placeholder="0,00"
                      :disabled="savingMonth === row.month"
                      @blur="saveMonth(row.month)"
                      @keyup.enter="saveMonth(row.month)"
                    />
                  </div>
                  <button
                    v-if="row.invoicedGrossCents > 0 && row.invoicedGrossCents !== row.grossCents"
                    class="btn-xs mt-1"
                    title="Aus den Rechnungen des Monats übernehmen"
                    @click="adopt(row)"
                  >
                    ↙ {{ formatMoney(row.invoicedGrossCents) }}
                  </button>
                </td>
                <td v-if="rates.discountRate > 0" class="text-right tabular-nums text-muted">
                  {{ formatMoney(row.discountCents) }}
                </td>
                <td class="text-right tabular-nums text-muted">{{ formatMoney(row.vatCents) }}</td>
                <td class="text-right tabular-nums">{{ formatMoney(row.netCents) }}</td>
                <td class="text-right tabular-nums text-warn">
                  {{ formatMoney(row.reserveCents) }}
                </td>
                <td class="text-right tabular-nums text-muted">{{ formatMoney(row.costCents) }}</td>
                <td
                  class="text-right font-semibold tabular-nums"
                  :class="row.payoutCents < 0 ? 'text-bad' : ''"
                >
                  {{ formatMoney(row.payoutCents) }}
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr class="border-t-2 border-ink">
                <td class="font-semibold">Jahr</td>
                <td class="text-right font-semibold tabular-nums">
                  {{ formatMoney(total.grossCents) }}
                </td>
                <td v-if="rates.discountRate > 0" class="text-right tabular-nums">
                  {{ formatMoney(total.discountCents) }}
                </td>
                <td class="text-right tabular-nums">{{ formatMoney(total.vatCents) }}</td>
                <td class="text-right tabular-nums">{{ formatMoney(total.netCents) }}</td>
                <td class="text-right tabular-nums text-warn">
                  {{ formatMoney(total.reserveCents) }}
                </td>
                <td class="text-right tabular-nums">{{ formatMoney(total.costCents) }}</td>
                <td class="text-right font-semibold tabular-nums">
                  {{ formatMoney(total.payoutCents) }}
                </td>
              </tr>
            </tfoot>
          </table>

          <p class="mt-3 text-xs leading-relaxed text-muted">
            Ans Finanzamt gehen {{ formatMoney(total.setAsideCents) }} — Umsatzsteuer plus Rücklage.
            Das Geld lag nie dir, es lag nur auf deinem Konto.
          </p>
        </section>

        <div class="space-y-4">
          <section class="card">
            <h2 class="eyebrow mb-3">Sätze {{ year }}</h2>
            <form class="space-y-3" @submit.prevent="saveRates">
              <div>
                <label class="label" for="rate-vat">Umsatzsteuer (%)</label>
                <input
                  id="rate-vat"
                  v-model.number="rates.vatRate"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  class="input tabular-nums"
                />
              </div>
              <div>
                <label class="label" for="rate-income">Einkommen + Gewerbe (%)</label>
                <input
                  id="rate-income"
                  v-model.number="rates.incomeTaxRate"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  class="input tabular-nums"
                />
              </div>
              <div>
                <label class="label" for="rate-discount">Skonto (%)</label>
                <input
                  id="rate-discount"
                  v-model.number="rates.discountRate"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  class="input tabular-nums"
                />
              </div>
              <div>
                <label class="label" for="reserve-note">Notiz</label>
                <textarea id="reserve-note" v-model="note" rows="3" class="input" />
              </div>
              <button class="btn-primary w-full" :disabled="savingRates || !ratesDirty">
                {{ savingRates ? 'Speichert …' : ratesDirty ? 'Sätze speichern' : 'Gespeichert' }}
              </button>
            </form>
          </section>

          <CostList
            :year="year"
            :costs="view.costs"
            :per-month-cents="view.costPerMonthCents"
            @saved="apply"
          />

          <section class="card text-xs leading-relaxed text-muted">
            <h2 class="eyebrow mb-3">So wird gerechnet</h2>
            <p>
              Brutto minus Skonto, daraus die Umsatzsteuer herausgerechnet — nicht draufgeschlagen.
              Vom Netto gehen der Steuersatz als Rücklage und die Geschäftskosten ab; der Rest ist
              die Auszahlung. Die Sätze hängen am Jahr, eine Korrektur hier schreibt also keine
              Vorjahre um.
            </p>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>
