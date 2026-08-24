<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api'

type Hit = { type: string; id: string; title: string; snippet: string; url: string }

const router = useRouter()
const query = ref('')
const hits = ref<Hit[]>([])
const open = ref(false)
const field = ref<HTMLInputElement | null>(null)
let handle: ReturnType<typeof setTimeout> | null = null

watch(query, (value) => {
  if (handle) clearTimeout(handle)
  if (value.trim().length < 2) {
    hits.value = []
    open.value = false
    return
  }
  handle = setTimeout(async () => {
    const res = await api.get<{ hits: Hit[] }>('/api/search', { q: value.trim() })
    hits.value = res.hits
    open.value = true
  }, 250)
})

function go(hit: Hit) {
  open.value = false
  query.value = ''
  router.push(hit.url)
}

/** ⌘K / Strg+K fokussiert die Suche von überall. */
function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    field.value?.focus()
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))

const typeLabel: Record<string, string> = {
  note: 'Notiz',
  meeting: 'Meeting',
  transcript: 'Transkript',
  project: 'Projekt',
  client: 'Kunde',
  invoice: 'Rechnung',
}
</script>

<template>
  <div class="relative">
    <div class="flex items-center gap-3 border border-line bg-raised px-3 focus-within:border-ink">
      <span class="text-muted">⌕</span>
      <input
        ref="field"
        v-model="query"
        class="w-full bg-transparent py-2 text-sm text-ink outline-none placeholder:text-muted/70"
        placeholder="Notizen, Transkripte, Projekte, Rechnungen …"
        @focus="open = hits.length > 0"
        @keydown.escape="open = false"
      />
      <kbd
        class="hidden shrink-0 border border-line px-1.5 py-0.5 font-display text-[10px] text-muted md:block"
      >
        ⌘K
      </kbd>
    </div>

    <div
      v-if="open && hits.length"
      class="popover absolute z-30 mt-px max-h-96 w-full overflow-y-auto"
    >
      <button
        v-for="hit in hits"
        :key="`${hit.type}-${hit.id}`"
        class="block w-full border-b border-line px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-acid"
        @click="go(hit)"
      >
        <div class="flex items-center gap-2">
          <span class="badge">{{ typeLabel[hit.type] ?? hit.type }}</span>
          <span class="truncate text-sm font-medium">{{ hit.title }}</span>
        </div>
        <div v-if="hit.snippet" class="mt-0.5 line-clamp-2 text-xs text-muted" v-html="hit.snippet" />
      </button>
    </div>

    <div v-if="open" class="fixed inset-0 z-20" @click="open = false" />
  </div>
</template>
