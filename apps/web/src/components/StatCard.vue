<script setup lang="ts">
defineProps<{ label: string; value: string; hint?: string; tone?: 'default' | 'warn' | 'good' | 'bad' }>()
</script>

<template>
  <!-- Kein Kasten, nur eine kräftige Oberkante — wie die Kennzahlen auf der Website -->
  <div class="border-t-2 border-ink pt-3">
    <div class="eyebrow-muted">{{ label }}</div>
    <div
      class="mt-1.5 font-display text-3xl font-semibold leading-none tracking-[-0.02em] tabular-nums"
      :class="{
        'text-warn': tone === 'warn',
        'text-good': tone === 'good',
        'text-bad': tone === 'bad',
      }"
    >
      {{ value }}
    </div>
    <div v-if="hint" class="mt-1.5 text-xs text-muted">{{ hint }}</div>
  </div>
</template>
