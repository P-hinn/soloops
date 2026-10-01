<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '@/api'

/**
 * The Claude connection as a card.
 *
 * Inside the macOS app the button does the whole job: the connector goes into
 * Claude Desktop's config and into Claude Code, both with absolute paths. In
 * the browser there is no way to reach those files, so the card shows the
 * snippet instead — the same text the app would write.
 */

type Wiring = 'missing' | 'stale' | 'connected' | 'unavailable'
type Native = {
  desktop: Wiring
  code: Wiring
  desktopConfig: string
  dir: string
  spec: Record<string, unknown> | null
  problem: string | null
  claudeRunning: boolean
}
type Outcome = { ok: boolean; changed: boolean; message: string }
type Report = { desktop: Outcome; code: Outcome; restartNeeded: boolean; opened: boolean }
type ServerStatus = { lastSeenAt: string | null; entry: string; runner: string }

const bridge = window.__TAURI__?.core
const native = ref<Native | null>(null)
const server = ref<ServerStatus | null>(null)
const busy = ref('')
const error = ref('')
const results = ref<Outcome[]>([])
const restartNeeded = ref(false)
const copied = ref(false)

const labels: Record<Wiring, string> = {
  connected: 'verbunden',
  stale: 'veralteter Eintrag',
  missing: 'nicht verbunden',
  unavailable: 'nicht gefunden',
}
const badge: Record<Wiring, string> = {
  connected: 'badge-good',
  stale: 'badge-warn',
  missing: '',
  unavailable: '',
}

/** The block as it belongs in claude_desktop_config.json. */
const snippet = computed(() => {
  const dir = native.value?.dir ?? '/Pfad/zu/soloops'
  const spec = native.value?.spec ?? {
    command: 'npx',
    args: ['tsx', `${dir}/${server.value?.entry ?? 'apps/mcp/src/index.ts'}`],
    env: { SOLOOPS_URL: 'http://localhost:3000' },
  }
  return JSON.stringify({ mcpServers: { soloops: spec } }, null, 2)
})

const lastSeen = computed(() => {
  const at = server.value?.lastSeenAt
  if (!at) return null
  return new Date(at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
})

async function load() {
  server.value = await api.get<ServerStatus>('/api/claude/status')
  if (bridge) native.value = await bridge.invoke<Native>('claude_status')
}

async function connect() {
  busy.value = 'connect'
  error.value = ''
  results.value = []
  try {
    const report = await bridge!.invoke<Report>('claude_connect')
    results.value = [report.desktop, report.code]
    restartNeeded.value = report.restartNeeded
    if (report.opened) results.value.push({ ok: true, changed: false, message: 'Claude geöffnet.' })
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function restart() {
  busy.value = 'restart'
  error.value = ''
  try {
    await bridge!.invoke('claude_restart_desktop')
    restartNeeded.value = false
    results.value = [{ ok: true, changed: false, message: 'Claude Desktop neu gestartet.' }]
  } catch (err) {
    error.value = String(err)
  } finally {
    busy.value = ''
  }
}

async function copy() {
  await navigator.clipboard.writeText(snippet.value)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}

onMounted(() => {
  load().catch((err) => (error.value = (err as Error).message))
})
</script>

<template>
  <section class="card">
    <h2 class="eyebrow mb-1">Claude</h2>
    <p class="mb-4 text-xs text-muted">
      Claude bekommt über den MCP-Server Zugriff auf alles hier — Termine setzen, Leads anlegen und
      pflegen, Notizen und Zeiten schreiben, während du recherchierst.
    </p>

    <!-- What is wired where -->
    <dl v-if="native" class="mb-4 border-t border-line-strong text-sm">
      <div class="flex items-center justify-between border-b border-line py-2">
        <dt>Claude Desktop</dt>
        <dd>
          <span class="badge" :class="badge[native.desktop]">{{ labels[native.desktop] }}</span>
        </dd>
      </div>
      <div class="flex items-center justify-between border-b border-line py-2">
        <dt>Claude Code</dt>
        <dd>
          <span class="badge" :class="badge[native.code]">{{ labels[native.code] }}</span>
        </dd>
      </div>
      <div class="flex items-center justify-between border-b border-line py-2">
        <dt class="text-muted">Zuletzt genutzt</dt>
        <dd class="tabular-nums">{{ lastSeen ?? 'noch nie' }}</dd>
      </div>
    </dl>

    <p v-if="native?.problem" class="mb-3 border-l-2 border-bad px-3 py-2 text-sm text-bad">
      {{ native.problem }}
    </p>

    <!-- The one button, available only in the app -->
    <template v-if="bridge">
      <div class="flex flex-wrap items-center gap-2">
        <button class="btn-primary" :disabled="busy !== '' || !!native?.problem" @click="connect()">
          {{ busy === 'connect' ? 'verbinde …' : 'Mit Claude verbinden' }}
        </button>
        <button v-if="restartNeeded" class="btn-acid" :disabled="busy !== ''" @click="restart()">
          {{ busy === 'restart' ? 'starte neu …' : 'Claude Desktop neu starten' }}
        </button>
      </div>
      <p class="mt-2 text-xs text-muted">
        Schreibt den Connector in die Config von Claude Desktop (vorher eine Kopie daneben) und
        meldet ihn per CLI bei Claude Code an — dort für alle Projekte.
      </p>
      <p v-if="restartNeeded" class="mt-2 text-xs text-muted">
        Claude Desktop liest die Config nur beim Start. Bis zum Neustart taucht der Connector dort
        nicht auf.
      </p>
    </template>
    <p v-else class="text-xs text-muted">
      Das Eintragen läuft über die Mac-App — im Browser kommt soloops an die Config von Claude nicht
      heran. Für eine andere Maschine reicht der Block unten.
    </p>

    <ul v-if="results.length" class="mt-3 space-y-1 text-sm">
      <li v-for="(r, i) in results" :key="i" :class="r.ok ? 'text-good' : 'text-bad'">
        {{ r.message }}
      </li>
    </ul>
    <p v-if="error" class="mt-3 border-l-2 border-bad px-3 py-2 text-sm text-bad">{{ error }}</p>

    <!-- Fallback for every Claude that does not run on this Mac -->
    <details class="mt-4">
      <summary class="cursor-pointer text-xs text-muted">Von Hand eintragen</summary>
      <p class="mt-2 text-xs text-muted">
        Gehört in
        <code class="border border-line bg-paper-2 px-1">{{
          native?.desktopConfig ?? '~/Library/Application Support/Claude/claude_desktop_config.json'
        }}</code
        >. Auf einem anderen Rechner zusätzlich
        <code class="border border-line bg-paper-2 px-1">SOLOOPS_TOKEN</code> aus der
        <code class="border border-line bg-paper-2 px-1">.env</code> in
        <code class="border border-line bg-paper-2 px-1">env</code> ergänzen — lokal liest der
        Server sie selbst.
      </p>
      <pre class="mt-2 overflow-x-auto bg-paper p-3 text-xs text-soft">{{ snippet }}</pre>
      <button class="btn-xs" @click="copy()">{{ copied ? 'kopiert' : 'Kopieren' }}</button>
    </details>
  </section>
</template>
