<script setup lang="ts">
defineProps<{ title: string; subtitle?: string; eyebrow?: string }>()
</script>

<template>
  <div class="mb-8 border-b border-line-strong pb-5">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <div v-if="eyebrow" class="eyebrow mb-2">{{ eyebrow }}</div>
        <h1 class="display-xl">{{ title }}</h1>
        <p v-if="subtitle" class="mt-1.5 text-sm text-muted">{{ subtitle }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <slot name="actions" />
      </div>
    </div>
  </div>
</template>
