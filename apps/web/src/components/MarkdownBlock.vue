<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'

const props = defineProps<{ source?: string | null }>()

/**
 * Renders Markdown without sanitising — which is only acceptable because
 * nothing but self-written content passes through here (notes, transcripts).
 *
 * Since the inbox arrived, foreign text lives in the system too: mail bodies
 * and everything an AI derives from them. Those are deliberately emitted as
 * plain text and must not come through here. Change that, and put DOMPurify
 * in front of it first.
 */
const html = computed(() => (props.source ? marked.parse(props.source, { async: false }) : ''))
</script>

<template>
  <!--
    v-html is deliberate here: the content is our own. Nothing that came out
    of a mail may take this path — see the comment above.
  -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div v-if="html" class="prose-note text-sm" v-html="html" />
  <p v-else class="text-sm text-muted">—</p>
</template>
