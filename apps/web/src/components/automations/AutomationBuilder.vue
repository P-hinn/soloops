<script setup lang="ts">
/**
 * The n8n editor, inside soloops.
 *
 * An iframe and not a rebuild. n8n's canvas is the thing being asked for here,
 * and the only way to have *that* canvas is to run it. What makes it feel like
 * one application rather than two is that it is served from the same origin
 * under /n8n/ — see the proxy in vite.config.ts and deploy/nginx.conf. Without
 * that, X-Frame-Options leaves this box empty.
 *
 * n8n keeps its own session. The first visit asks for an owner account; after
 * that the cookie carries and this is simply the editor.
 */
import { ref } from 'vue'

const props = defineProps<{
  /** Same-origin path to the editor, from /api/automations/status. */
  src: string
  reachable: boolean
}>()

/**
 * A key we bump to force a reload. Changing the `src` back to itself would not
 * do it, and reaching into contentWindow is blocked for anything but
 * same-origin — which this is, but relying on that for a reload button is
 * fragile the first time someone puts n8n on another host.
 */
const nonce = ref(0)
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <div class="mb-3 flex items-center justify-between gap-3">
      <p class="text-xs text-muted">
        Der n8n-Editor läuft eingebettet unter
        <code class="font-mono text-ink">{{ props.src }}</code
        >. Gebaute Flows erscheinen nach dem nächsten Abgleich unter „Flows“.
      </p>
      <div class="flex shrink-0 items-center gap-2">
        <button class="btn-ghost btn-xs" @click="nonce++">Neu laden</button>
        <a class="btn-ghost btn-xs" :href="props.src" target="_blank" rel="noopener">
          Im Tab öffnen
        </a>
      </div>
    </div>

    <!--
      An explicit tall frame rather than flex-1. The main column scrolls, so
      flex-1 collapses to whatever is left over — around 450px, which is not
      a canvas anyone can lay a workflow out on. The viewport height minus the
      chrome above it is, and the floor keeps it usable on a short laptop
      screen where the page then scrolls instead.
    -->
    <div
      v-if="props.reachable"
      class="h-[calc(100vh-13rem)] min-h-[560px] overflow-hidden border border-line-strong bg-raised"
    >
      <iframe
        :key="nonce"
        :src="props.src"
        class="h-full w-full"
        title="n8n"
        allow="clipboard-read; clipboard-write"
      />
    </div>

    <div v-else class="card">
      <h3 class="font-display text-base font-semibold">n8n antwortet nicht</h3>
      <p class="mt-2 text-sm text-muted">
        Der Container ist nicht erreichbar. In der Entwicklung bringt
        <code class="font-mono text-ink">npm run up</code> ihn mit hoch; danach steht der Editor
        unter <code class="font-mono text-ink">{{ props.src }}</code> und direkt auf Port 5678.
      </p>
    </div>
  </div>
</template>
