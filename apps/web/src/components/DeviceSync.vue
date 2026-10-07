<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { api } from '@/api'

/**
 * The iPhone, as a card.
 *
 * Pairing has to start somewhere both devices can see, and without a server
 * that is this screen: the Mac shows a code, the phone redeems it over the
 * local network, and from then on the two talk directly. The code is
 * single-use and lives ten minutes — see services/syncPairing.ts.
 */

type Device = {
  id: string
  name: string
  platform: string
  pairedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
  cursor: string
}
type Overview = {
  host: string
  port: number
  addresses: string[]
  devices: Device[]
  ops: number
}
type Offer = { code: string; expiresAt: string; port: number; addresses: string[] }

const overview = ref<Overview | null>(null)
const offer = ref<Offer | null>(null)
const busy = ref('')
const error = ref('')
const copied = ref('')
const now = ref(Date.now())

let ticker: number | undefined

/** The phones, not this machine's own processes. */
const phones = computed(() => overview.value?.devices.filter((d) => d.platform === 'ios') ?? [])

/**
 * The link the phone needs. Every address the Mac has, because only the phone
 * knows which of them it can reach — the app tries them in order.
 */
const pairingUrl = computed(() => {
  if (!offer.value) return ''
  const hosts = offer.value.addresses.map((a) => `host=${encodeURIComponent(a)}`).join('&')
  return `soloops://pair?code=${offer.value.code}&${hosts}&port=${offer.value.port}`
})

const secondsLeft = computed(() => {
  if (!offer.value) return 0
  return Math.max(0, Math.round((Date.parse(offer.value.expiresAt) - now.value) / 1000))
})

const expired = computed(() => offer.value !== null && secondsLeft.value === 0)

const countdown = computed(() => {
  const total = secondsLeft.value
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
})

function when(value: string | null): string {
  if (!value) return 'noch nie'
  return new Date(value).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })
}

async function load() {
  overview.value = await api.get<Overview>('/api/sync/devices')
}

async function startPairing() {
  busy.value = 'pair'
  error.value = ''
  try {
    offer.value = await api.post<Offer>('/api/sync/pair/start')
    now.value = Date.now()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function cancelPairing() {
  busy.value = 'cancel'
  try {
    await api.post('/api/sync/pair/cancel')
    offer.value = null
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function revoke(device: Device) {
  // Irreversible for that device — it has to be paired again afterwards — so
  // it gets a confirmation rather than being one misclick away.
  if (!confirm(`Kopplung von "${device.name}" lösen? Das Gerät muss neu gekoppelt werden.`)) return
  busy.value = device.id
  error.value = ''
  try {
    await api.post(`/api/sync/devices/${device.id}/revoke`)
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text)
  copied.value = what
  setTimeout(() => (copied.value = ''), 2000)
}

onMounted(() => {
  load().catch((err) => (error.value = (err as Error).message))
  // Only for the countdown and to notice a phone that has just paired while
  // this screen is open.
  ticker = window.setInterval(() => {
    now.value = Date.now()
    if (offer.value) load().catch(() => {})
  }, 1000)
})

onUnmounted(() => {
  if (ticker) window.clearInterval(ticker)
})
</script>

<template>
  <section class="card">
    <h2 class="eyebrow mb-1">iPhone</h2>
    <p class="mb-4 text-xs text-muted">
      Termine, Leads, Zeiten und Notizen laufen direkt zwischen diesem Mac und dem iPhone — im WLAN
      sofort, sonst über deinen iCloud-Ordner. Kein Server dazwischen, die Daten liegen nur auf den
      beiden Geräten.
    </p>

    <!-- The paired phones -->
    <dl v-if="overview" class="mb-4 border-t border-line-strong text-sm">
      <div
        v-for="device in phones"
        :key="device.id"
        class="flex items-center justify-between border-b border-line py-2"
      >
        <dt>
          {{ device.name }}
          <span v-if="device.revokedAt" class="badge">gelöst</span>
        </dt>
        <dd class="flex items-center gap-3">
          <span class="text-xs text-muted">zuletzt {{ when(device.lastSeenAt) }}</span>
          <button
            v-if="!device.revokedAt"
            class="btn-xs"
            :disabled="busy !== ''"
            @click="revoke(device)"
          >
            lösen
          </button>
        </dd>
      </div>
      <div
        v-if="phones.length === 0"
        class="flex items-center justify-between border-b border-line py-2"
      >
        <dt class="text-muted">Kein Gerät gekoppelt</dt>
      </div>
      <div class="flex items-center justify-between border-b border-line py-2">
        <dt class="text-muted">Änderungen im Protokoll</dt>
        <dd class="tabular-nums">{{ overview.ops }}</dd>
      </div>
    </dl>

    <!-- Pairing -->
    <template v-if="!offer">
      <button class="btn-primary" :disabled="busy !== ''" @click="startPairing()">
        {{ busy === 'pair' ? 'erzeuge …' : 'iPhone koppeln' }}
      </button>
      <p class="mt-2 text-xs text-muted">
        Erzeugt einen Code, der zehn Minuten gilt und genau einmal benutzt werden kann.
      </p>
    </template>

    <template v-else>
      <div class="border border-line-strong bg-paper-2 p-4">
        <p v-if="expired" class="text-sm text-bad">
          Code abgelaufen. Einen neuen erzeugen und am iPhone noch einmal versuchen.
        </p>
        <template v-else>
          <p class="mb-1 text-xs text-muted">Code am iPhone eingeben — noch {{ countdown }}</p>
          <p class="mb-3 font-mono text-3xl tracking-[0.2em] tabular-nums">{{ offer.code }}</p>

          <p class="mb-1 text-xs text-muted">
            Dazu die Adresse dieses Macs. Falls mehrere dastehen: die aus demselben Netz wie das
            iPhone.
          </p>
          <ul class="mb-3 space-y-1">
            <li v-for="address in offer.addresses" :key="address" class="flex items-center gap-2">
              <code class="border border-line bg-paper px-1 text-sm">{{ address }}</code>
              <button class="btn-xs" @click="copy(address, address)">
                {{ copied === address ? 'kopiert' : 'kopieren' }}
              </button>
            </li>
          </ul>
          <p v-if="offer.addresses.length === 0" class="mb-3 text-sm text-bad">
            Dieser Mac hat keine Netzwerkadresse, die das iPhone erreichen könnte. Im selben WLAN?
          </p>
        </template>

        <div class="flex flex-wrap items-center gap-2">
          <button class="btn-xs" :disabled="busy !== ''" @click="startPairing()">Neuer Code</button>
          <button class="btn-xs" :disabled="busy !== ''" @click="cancelPairing()">Abbrechen</button>
        </div>
      </div>

      <details class="mt-3">
        <summary class="cursor-pointer text-xs text-muted">Als Link</summary>
        <p class="mt-2 text-xs text-muted">
          Enthält Code und Adressen in einem. Praktisch, wenn das iPhone den Link ohnehin erreicht —
          per AirDrop oder aus einer Notiz heraus geöffnet, koppelt sich die App ohne Eingabe.
        </p>
        <pre class="mt-2 overflow-x-auto bg-paper p-3 text-xs text-soft">{{ pairingUrl }}</pre>
        <button class="btn-xs" @click="copy(pairingUrl, 'url')">
          {{ copied === 'url' ? 'kopiert' : 'Kopieren' }}
        </button>
      </details>
    </template>

    <p v-if="error" class="mt-3 border-l-2 border-bad px-3 py-2 text-sm text-bad">{{ error }}</p>
  </section>
</template>
