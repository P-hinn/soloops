<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/api'

type Hit = { type: string; id: string; title: string; snippet: string; url: string }

const router = useRouter()
const query = ref('')
const hits = ref<Hit[]>([])
const open = ref(false)
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
    <input
      v-model="query"
      class="input"
      placeholder="Suche über Notizen, Transkripte, Projekte, Rechnungen …"
      @focus="open = hits.length > 0"
      @keydown.escape="open = false"
    />

    <div
      v-if="open && hits.length"
      class="absolute z-30 mt-1 max-h-96 w-full overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl"
    >
      <button
        v-for="hit in hits"
        :key="`${hit.type}-${hit.id}`"
        class="block w-full border-b border-zinc-800/60 px-4 py-2.5 text-left last:border-0 hover:bg-zinc-800"
        @click="go(hit)"
      >
        <div class="flex items-center gap-2">
          <span class="badge bg-zinc-800 text-zinc-400">{{ typeLabel[hit.type] ?? hit.type }}</span>
          <span class="truncate text-sm font-medium">{{ hit.title }}</span>
        </div>
        <div v-if="hit.snippet" class="mt-0.5 line-clamp-2 text-xs text-zinc-500" v-html="hit.snippet" />
      </button>
    </div>

    <div v-if="open" class="fixed inset-0 z-20" @click="open = false" />
  </div>
</template>
