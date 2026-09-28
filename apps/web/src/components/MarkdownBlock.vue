<script setup lang="ts">
import { computed } from 'vue'
import { marked } from 'marked'

const props = defineProps<{ source?: string | null }>()

/**
 * Rendert Markdown ohne Sanitisierung — das ist nur zulässig, weil hier
 * ausschließlich selbst getippte Inhalte durchlaufen (Notizen, Mitschriften).
 *
 * Seit dem Postfach liegen auch fremde Texte im System: Mailinhalte und alles,
 * was eine AI daraus ableitet. Die werden bewusst als Klartext ausgegeben und
 * dürfen hier nicht durch. Wer das ändert, schaltet vorher DOMPurify davor.
 */
const html = computed(() => (props.source ? marked.parse(props.source, { async: false }) : ''))
</script>

<template>
  <!--
    v-html ist hier Absicht: der Inhalt stammt aus eigener Hand. Nichts, was
    aus einer Mail kommt, darf diesen Weg nehmen — siehe Kommentar oben.
  -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div v-if="html" class="prose-note text-sm" v-html="html" />
  <p v-else class="text-sm text-muted">—</p>
</template>
