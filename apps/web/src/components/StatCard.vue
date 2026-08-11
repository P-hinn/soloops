<script setup lang="ts">
defineProps<{ label: string; value: string; hint?: string; tone?: 'default' | 'warn' | 'good' }>()
</script>

<template>
  <div class="card">
    <div class="text-xs uppercase tracking-wide text-zinc-500">{{ label }}</div>
    <div
      class="mt-1 text-2xl font-semibold tabular-nums"
      :class="{
        'text-amber-400': tone === 'warn',
        'text-emerald-400': tone === 'good',
      }"
    >
      {{ value }}
    </div>
    <div v-if="hint" class="mt-1 text-xs text-zinc-500">{{ hint }}</div>
  </div>
</template>
