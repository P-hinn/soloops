<script setup lang="ts">
defineProps<{
  label: string
  value: string
  hint?: string
  tone?: 'default' | 'warn' | 'good' | 'bad'
}>()
</script>

<template>
  <!-- Kein Kasten, nur eine kräftige Oberkante. Sie trägt die Farbe: eine
       Kennzahl, die Aufmerksamkeit braucht, sagt das schon über die Linie. -->
  <div
    class="border-t-2 pt-3"
    :class="{
      'border-ink': !tone || tone === 'default',
      'border-warn': tone === 'warn',
      'border-good': tone === 'good',
      'border-bad': tone === 'bad',
    }"
  >
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
