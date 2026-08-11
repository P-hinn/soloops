<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useOnboarding } from '@/stores/onboarding'

const onboarding = useOnboarding()

const state = computed(() => onboarding.state)
const essential = computed(() => state.value?.steps.filter((s) => s.essential) ?? [])
const optional = computed(() => state.value?.steps.filter((s) => !s.essential) ?? [])
const progress = computed(() =>
  state.value ? Math.round((state.value.done / state.value.total) * 100) : 0,
)
</script>

<template>
  <section v-if="onboarding.visible && state" data-tour="checklist" class="border-2 border-ink">
    <header class="flex flex-wrap items-center gap-3 border-b border-ink bg-acid px-4 py-2.5">
      <span class="eyebrow-muted !text-ink">Einrichtung</span>
      <span class="font-display text-sm font-semibold tabular-nums">
        {{ state.done }} / {{ state.total }}
      </span>
      <div class="h-1.5 w-32 border border-ink">
        <div class="h-full bg-ink" :style="{ width: `${progress}%` }" />
      </div>
      <span v-if="state.essentialDone < state.essentialTotal" class="text-xs text-ink/70">
        {{ state.essentialTotal - state.essentialDone }} Pflichtschritt(e) offen
      </span>
      <span v-else class="text-xs text-ink/70">Grundgerüst steht — der Rest ist Kür.</span>

      <div class="ml-auto flex gap-2">
        <button
          class="border border-ink px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] hover:bg-ink hover:text-acid"
          @click="onboarding.openTour()"
        >
          Tour starten
        </button>
        <button
          class="border border-ink px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] hover:bg-ink hover:text-acid"
          @click="onboarding.dismiss()"
        >
          Ausblenden
        </button>
      </div>
    </header>

    <div class="grid gap-x-8 gap-y-0 px-4 py-3 lg:grid-cols-2">
      <div>
        <h3 class="eyebrow-muted mb-2">Grundgerüst</h3>
        <ul>
          <li
            v-for="step in essential"
            :key="step.id"
            class="flex items-start gap-3 border-b border-line py-2.5 last:border-0"
            :class="step.id === state.next ? 'bg-acid/25 -mx-2 px-2' : ''"
          >
            <span
              class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] font-bold"
              :class="step.done ? 'border-ink bg-ink text-paper' : 'border-line-strong text-transparent'"
            >
              ✓
            </span>
            <div class="min-w-0 flex-1">
              <div class="text-sm" :class="step.done ? 'text-muted line-through' : 'font-medium'">
                {{ step.title }}
              </div>
              <p v-if="!step.done" class="mt-0.5 text-xs text-muted">{{ step.why }}</p>
              <p v-if="!step.done && step.hint" class="mt-1 font-display text-[11px] text-soft">
                {{ step.hint }}
              </p>
            </div>
            <RouterLink v-if="!step.done && step.action" :to="step.action.url" class="btn-xs shrink-0">
              {{ step.action.label }}
            </RouterLink>
          </li>
        </ul>
      </div>

      <div>
        <h3 class="eyebrow-muted mb-2">Danach</h3>
        <ul>
          <li
            v-for="step in optional"
            :key="step.id"
            class="flex items-start gap-3 border-b border-line py-2.5 last:border-0"
            :class="step.id === state.next ? 'bg-acid/25 -mx-2 px-2' : ''"
          >
            <span
              class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] font-bold"
              :class="step.done ? 'border-ink bg-ink text-paper' : 'border-line-strong text-transparent'"
            >
              ✓
            </span>
            <div class="min-w-0 flex-1">
              <div class="text-sm" :class="step.done ? 'text-muted line-through' : 'font-medium'">
                {{ step.title }}
              </div>
              <p v-if="!step.done" class="mt-0.5 text-xs text-muted">{{ step.why }}</p>
              <p v-if="!step.done && step.hint" class="mt-1 font-display text-[11px] text-soft">
                {{ step.hint }}
              </p>
            </div>
            <RouterLink v-if="!step.done && step.action" :to="step.action.url" class="btn-xs shrink-0">
              {{ step.action.label }}
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
