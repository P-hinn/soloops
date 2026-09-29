<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useOnboarding } from '@/stores/onboarding'

/**
 * One line by default, not twelve.
 *
 * Expanded, the list was the first and largest thing on the dashboard — a
 * wall of small grey text pushing the actual work area down. So only the
 * progress and the next step stay visible; everything else on click.
 */
const onboarding = useOnboarding()
const open = ref(false)

const state = computed(() => onboarding.state)
const essential = computed(() => state.value?.steps.filter((s) => s.essential) ?? [])
const optional = computed(() => state.value?.steps.filter((s) => !s.essential) ?? [])
const nextStep = computed(() => state.value?.steps.find((s) => s.id === state.value?.next) ?? null)
const progress = computed(() =>
  state.value ? Math.round((state.value.done / state.value.total) * 100) : 0,
)
</script>

<template>
  <section v-if="onboarding.visible && state" data-tour="checklist" class="border border-ink">
    <!-- Header: always visible, one line -->
    <header class="flex flex-wrap items-center gap-x-4 gap-y-2 bg-acid px-4 py-2.5">
      <span class="eyebrow-muted !text-ink">Einrichtung</span>

      <span class="flex items-center gap-2">
        <span class="font-display text-sm font-semibold tabular-nums">
          {{ state.done }}/{{ state.total }}
        </span>
        <span class="h-1.5 w-24 border border-ink/60">
          <span class="block h-full bg-ink" :style="{ width: `${progress}%` }" />
        </span>
      </span>

      <button
        v-if="nextStep"
        class="min-w-0 flex-1 truncate text-left text-sm hover:underline"
        @click="open = !open"
      >
        <span class="text-ink/60">Als Nächstes:</span>
        <span class="font-medium">{{ nextStep.title }}</span>
      </button>
      <span v-else class="flex-1 text-sm">Alles erledigt.</span>

      <RouterLink v-if="nextStep?.action" :to="nextStep.action.url" class="btn-primary !py-1.5">
        <span>{{ nextStep.action.label }}</span
        ><span aria-hidden="true">↗</span>
      </RouterLink>

      <div class="flex items-center gap-1">
        <button
          class="border border-ink px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors hover:bg-ink hover:text-acid"
          @click="open = !open"
        >
          {{ open ? 'Zuklappen' : 'Alle Schritte' }}
        </button>
        <button
          class="border border-ink px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors hover:bg-ink hover:text-acid"
          @click="onboarding.openTour()"
        >
          Tour
        </button>
        <button
          class="border border-ink px-2 py-1 text-[10px] font-bold uppercase tracking-[0.08em] transition-colors hover:bg-ink hover:text-acid"
          title="Ausblenden — in den Einstellungen wieder einblendbar"
          @click="onboarding.dismiss()"
        >
          ✕
        </button>
      </div>
    </header>

    <!-- Details only on request -->
    <div v-if="open" class="grid gap-x-8 bg-raised px-4 py-3 lg:grid-cols-2">
      <div>
        <h3 class="eyebrow-muted mb-1.5">
          Grundgerüst · {{ state.essentialDone }}/{{ state.essentialTotal }}
        </h3>
        <ul>
          <li
            v-for="step in essential"
            :key="step.id"
            class="flex items-start gap-2.5 border-b border-line py-2 last:border-0"
          >
            <span
              class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] font-bold"
              :class="
                step.done ? 'border-ink bg-ink text-paper' : 'border-line-strong text-transparent'
              "
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
            <RouterLink
              v-if="!step.done && step.action"
              :to="step.action.url"
              class="btn-xs shrink-0"
            >
              {{ step.action.label }}
            </RouterLink>
          </li>
        </ul>
      </div>

      <div>
        <h3 class="eyebrow-muted mb-1.5">Danach</h3>
        <ul>
          <li
            v-for="step in optional"
            :key="step.id"
            class="flex items-start gap-2.5 border-b border-line py-2 last:border-0"
          >
            <span
              class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[10px] font-bold"
              :class="
                step.done ? 'border-ink bg-ink text-paper' : 'border-line-strong text-transparent'
              "
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
            <RouterLink
              v-if="!step.done && step.action"
              :to="step.action.url"
              class="btn-xs shrink-0"
            >
              {{ step.action.label }}
            </RouterLink>
          </li>
        </ul>
      </div>
    </div>
  </section>
</template>
