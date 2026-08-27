<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'

const props = defineProps<{ source?: string | null }>()

/**
 * Inhalte stammen ausschließlich aus dem eigenen Backend (eigene Notizen,
 * eigene Transkripte) — deshalb reicht das Rendern ohne zusätzliche
 * Sanitisierung. Sobald fremde Inhalte hinzukommen: DOMPurify davorschalten.
 */
const html = computed(() => (props.source ? marked.parse(props.source, { async: false }) : ''))
</script>

<template>
  <!--
    v-html ist hier Absicht: der Inhalt stammt ausschließlich aus dem eigenen
    Backend (eigene Notizen, eigene Transkripte). Sobald fremde Inhalte
    hinzukommen, gehört DOMPurify davor.
  -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div v-if="html" class="prose-note text-sm" v-html="html" />
  <p v-else class="text-sm text-muted">—</p>
</template>
