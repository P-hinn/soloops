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
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

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

/**
 * Expand the canvas to the whole window — the application's own full screen,
 * not the operating system's.
 *
 * Laying out a workflow in a box beside a sidebar is cramped, and the macOS
 * full screen is the wrong tool: it hides the menu bar and the Dock for the
 * whole machine when all that is wanted is more canvas.
 *
 * Deliberately one iframe whose wrapper changes class, rather than two
 * iframes behind a v-if. Moving an iframe in the DOM reloads it, and a reload
 * here throws away whatever is on the canvas — expanding must not cost you
 * your unsaved workflow.
 */
const expanded = ref(false)

/** The frame itself, so the shortcut can be bound inside it as well. */
const frame = ref<HTMLIFrameElement | null>(null)

/**
 * Shift+Esc, and deliberately not plain Esc.
 *
 * n8n uses Esc itself — it closes the open node. Taking it would mean closing
 * a node panel also throws you out of the canvas, which is the opposite of
 * what either press meant.
 */
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && event.shiftKey && expanded.value) {
    event.preventDefault()
    expanded.value = false
  }
}

/**
 * The same handler inside the frame.
 *
 * A keypress with the focus on n8n's canvas is dispatched in the iframe's own
 * document and never reaches this one, so without this the shortcut would
 * work only in the moment right after clicking the button — which is the one
 * moment nobody needs it. Same origin is what makes this reachable at all;
 * the guard is there for an instance deliberately put on another host.
 */
function bindInsideFrame() {
  try {
    frame.value?.contentDocument?.addEventListener('keydown', onKey)
  } catch {
    // Cross-origin: the button stays the way out.
  }
}

function unbindInsideFrame() {
  try {
    frame.value?.contentDocument?.removeEventListener('keydown', onKey)
  } catch {
    // Nothing to clean up if it was never reachable.
  }
}

/**
 * While expanded the page behind must not scroll. The overlay covers it, so
 * a stray wheel event over it would otherwise move a document nobody can see.
 */
watch(expanded, (on) => {
  document.body.style.overflow = on ? 'hidden' : ''
})

onMounted(() => window.addEventListener('keydown', onKey))

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  unbindInsideFrame()
  // Leaving the tab while expanded must not leave the page unscrollable.
  document.body.style.overflow = ''
})
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
        <button v-if="props.reachable" class="btn-ghost btn-xs" @click="expanded = true">
          Vollbild
        </button>
        <button class="btn-ghost btn-xs" @click="nonce++">Neu laden</button>
        <a class="btn-ghost btn-xs" :href="props.src" target="_blank" rel="noopener">
          Im Tab öffnen
        </a>
      </div>
    </div>

    <!--
      One wrapper, two sets of classes. Inline it is the viewport height minus
      the chrome above it — flex-1 would collapse to about 450px inside the
      scrolling main column, which is not a canvas anyone can lay a workflow
      out on. Expanded it is fixed to the window and covers the sidebar, the
      header and these controls.

      z-90 and not higher: the guided tour sits at 100 and should still be
      able to appear over this.
    -->
    <div
      v-if="props.reachable"
      :class="
        expanded
          ? 'fixed inset-0 z-[90] bg-raised'
          : 'h-[calc(100vh-13rem)] min-h-[560px] overflow-hidden border border-line-strong bg-raised'
      "
    >
      <iframe
        :key="nonce"
        ref="frame"
        :src="props.src"
        class="h-full w-full"
        title="n8n"
        allow="clipboard-read; clipboard-write"
        @load="bindInsideFrame"
      />

      <!--
        The way out. Bottom right because n8n puts its own header across the
        top and its zoom controls bottom left — this is the one corner that
        stays free. Quiet until you reach for it, so it does not sit on the
        canvas shouting.
      -->
      <button
        v-if="expanded"
        class="fixed bottom-4 right-4 z-[91] flex items-center gap-2 rounded-full border border-ink bg-paper/80 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.08em] text-ink opacity-60 backdrop-blur transition-opacity hover:opacity-100"
        @click="expanded = false"
      >
        <span class="rounded border border-ink/40 px-1 py-px font-mono text-[9px] normal-case">
          ⇧Esc
        </span>
        Vollbild verlassen
      </button>
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
