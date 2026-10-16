<script setup lang="ts">
/**
 * One foldable group of the settings page.
 *
 * The page is long because it covers everything from the sender's address to
 * how often the worker looks at the inbox, and almost all of it is touched
 * once and then never again. So the groups fold, and which ones are open is
 * remembered — otherwise the fold is a thing to redo on every visit.
 *
 * `<details>` rather than a boolean and a `v-if`: the browser gives the
 * keyboard handling and the screen-reader semantics for free, and a group
 * that is closed is still found by the browser's own search.
 */
import { onMounted, ref } from 'vue'

const props = defineProps<{
  /** Stable key for remembering the state. */
  name: string
  title: string
  /** Open on the first visit, before anything was remembered. */
  openByDefault?: boolean
  /** A short word on the right — "3 verbunden", "unvollständig". */
  note?: string
}>()

const STORE = 'soloops.settings.open'
const open = ref(props.openByDefault ?? false)

function remembered(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}')
  } catch {
    // A corrupted entry is not worth an error — it is a fold state.
    return {}
  }
}

onMounted(() => {
  const state = remembered()[props.name]
  if (state !== undefined) open.value = state
})

function toggle(event: Event) {
  open.value = (event.target as HTMLDetailsElement).open
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...remembered(), [props.name]: open.value }))
  } catch {
    // Private mode, full disk. The page works, it just forgets.
  }
}
</script>

<template>
  <details :open="open" class="mb-4 border-t border-line-strong" @toggle="toggle">
    <summary
      class="flex cursor-pointer list-none items-center gap-2 py-2 select-none hover:text-ink"
    >
      <span
        class="text-muted transition-transform"
        :class="{ 'rotate-90': open }"
        aria-hidden="true"
        >›</span
      >
      <span class="eyebrow">{{ title }}</span>
      <span v-if="note" class="badge bg-paper-2 text-muted">{{ note }}</span>
    </summary>
    <div class="pt-2">
      <slot />
    </div>
  </details>
</template>

<style scoped>
/* Safari still draws its own triangle without this. */
summary::-webkit-details-marker {
  display: none;
}
</style>
