<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '@/api'

type Account = {
  id: string
  provider: 'GOOGLE' | 'APPLE'
  label: string
  accountId: string
  calendar: string | null
  direction: 'PULL' | 'PUSH' | 'BOTH'
  enabled: boolean
  lastSyncAt: string | null
  lastError: string | null
  linkedEvents: number
  hasRefreshToken: boolean
  isDefault: boolean
  allowRemoteDelete: boolean
}
type Overview = {
  googleConfigured: boolean
  appleUrl: string
  syncCron: string
  pendingDeletes: number
  accounts: Account[]
}
type Discovered = { href: string; displayName: string; supportsSyncCollection: boolean }

const route = useRoute()
const data = ref<Overview | null>(null)
const busy = ref('')
const error = ref('')
const info = ref('')

const appleForm = ref({ username: '', password: '', direction: 'BOTH' as const })
const appleCalendars = ref<Discovered[]>([])

const directionLabel: Record<string, string> = {
  BOTH: 'beide Richtungen',
  PULL: 'nur lesen',
  PUSH: 'nur schreiben',
}

async function load() {
  data.value = await api.get<Overview>('/api/calendar-accounts')
}

async function connectGoogle() {
  busy.value = 'google'
  error.value = ''
  try {
    const res = await api.get<{ url: string }>('/api/calendar-accounts/google/auth-url')
    // Google requires a real page navigation, not a fetch.
    window.location.href = res.url
  } catch (err) {
    error.value = (err as Error).message
    busy.value = ''
  }
}

async function discoverApple() {
  busy.value = 'apple-discover'
  error.value = ''
  appleCalendars.value = []
  try {
    const res = await api.post<{ calendars: Discovered[] }>(
      '/api/calendar-accounts/apple/discover',
      { username: appleForm.value.username, password: appleForm.value.password },
    )
    appleCalendars.value = res.calendars
    if (!res.calendars.length) error.value = 'Keine Kalender gefunden.'
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function addApple(calendar: Discovered) {
  busy.value = 'apple-add'
  error.value = ''
  try {
    await api.post('/api/calendar-accounts/apple', {
      username: appleForm.value.username,
      password: appleForm.value.password,
      calendarHref: calendar.href,
      calendarName: calendar.displayName,
      direction: appleForm.value.direction,
    })
    // Drop the password from the page's memory right away
    appleForm.value = { username: '', password: '', direction: 'BOTH' }
    appleCalendars.value = []
    info.value = 'Apple-Kalender verbunden. Erster Abgleich läuft beim nächsten Sync.'
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function syncOne(account: Account) {
  busy.value = account.id
  error.value = ''
  info.value = ''
  try {
    const r = await api.post<{
      pulled: number
      pushed: number
      deletedLocal: number
      deletedRemote: number
      conflicts: number
      skippedSeries: number
      error?: string
    }>(`/api/calendar-accounts/${account.id}/sync`)
    info.value = r.error
      ? `${account.label}: ${r.error}`
      : `${account.label}: ${r.pulled} rein, ${r.pushed} raus` +
        (r.deletedLocal || r.deletedRemote
          ? `, ${r.deletedLocal + r.deletedRemote} gelöscht`
          : '') +
        (r.conflicts ? `, ${r.conflicts} Konflikt(e)` : '') +
        (r.skippedSeries ? `, ${r.skippedSeries} Serie(n) nur gelesen` : '')
    await load()
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = ''
  }
}

async function setDirection(account: Account, direction: string) {
  await api.patch(`/api/calendar-accounts/${account.id}`, { direction })
  await load()
}

/** The target calendar for everything created in soloops. Exactly one. */
async function makeDefault(account: Account) {
  await api.patch(`/api/calendar-accounts/${account.id}`, { isDefault: true })
  info.value = `Neue Termine gehen ab jetzt nach „${account.calendar ?? account.label}".`
  await load()
}

async function toggleDelete(account: Account) {
  const next = !account.allowRemoteDelete
  if (
    next &&
    !confirm(
      `Wenn du einen Termin in soloops löschst, wird er dann auch in „${account.calendar ?? account.label}" entfernt — und damit auf allen Geräten. Wirklich freigeben?`,
    )
  )
    return
  await api.patch(`/api/calendar-accounts/${account.id}`, { allowRemoteDelete: next })
  await load()
}

async function toggle(account: Account) {
  await api.patch(`/api/calendar-accounts/${account.id}`, { enabled: !account.enabled })
  await load()
}

async function resetToken(account: Account) {
  await api.post(`/api/calendar-accounts/${account.id}/reset-token`)
  info.value = `${account.label}: nächster Abgleich liest alles neu.`
  await load()
}

async function remove(account: Account) {
  if (
    !confirm(
      `„${account.label}" trennen? Bereits synchronisierte Termine bleiben lokal erhalten, werden aber nicht mehr abgeglichen.`,
    )
  )
    return
  await api.del(`/api/calendar-accounts/${account.id}`)
  await load()
}

onMounted(async () => {
  // Feedback from the Google OAuth redirect
  if (route.query.calendar === 'connected') info.value = 'Google-Kalender verbunden.'
  if (route.query.calendar === 'error') error.value = `Google: ${route.query.message ?? 'Fehler'}`
  await load()
})
</script>

<template>
  <section class="card">
    <h2 class="eyebrow mb-1">Kalender-Sync</h2>
    <p class="mb-4 text-xs text-muted">
      Abgleich läuft automatisch (<code class="border border-line bg-paper-2 px-1">{{
        data?.syncCron
      }}</code
      >). Was in soloops entsteht, geht in den <strong>Zielkalender</strong> — nur in diesen einen.
      Termine aus einem Fremdkalender werden nie in einen anderen kopiert, Serien nur gelesen, und
      gelöscht wird dort drüben nur, wo du es ausdrücklich freigibst.
    </p>

    <p v-if="info" class="mb-3 border-l-2 border-acid bg-acid/20 px-3 py-2 text-sm">{{ info }}</p>
    <p v-if="error" class="mb-3 border-l-2 border-bad px-3 py-2 text-sm text-bad">{{ error }}</p>

    <!-- Connected accounts -->
    <ul v-if="data?.accounts.length" class="mb-6 border-t border-line-strong">
      <li v-for="a in data.accounts" :key="a.id" class="border-b border-line py-3">
        <div class="flex flex-wrap items-center gap-2">
          <span class="badge" :class="a.provider === 'GOOGLE' ? 'badge-blue' : ''">
            {{ a.provider === 'GOOGLE' ? 'Google' : 'Apple' }}
          </span>
          <span class="text-sm font-medium">{{ a.calendar ?? a.label }}</span>
          <span class="text-xs text-muted">{{ a.accountId }}</span>
          <span v-if="!a.enabled" class="badge badge-warn">pausiert</span>
          <span v-if="a.isDefault" class="badge badge-acid" title="Neue Termine landen hier">
            Zielkalender
          </span>

          <select
            class="input ml-auto w-auto py-1 text-xs"
            :value="a.direction"
            @change="setDirection(a, ($event.target as HTMLSelectElement).value)"
          >
            <option v-for="(label, value) in directionLabel" :key="value" :value="value">
              {{ label }}
            </option>
          </select>
          <button class="btn-xs" :disabled="busy === a.id" @click="syncOne(a)">
            {{ busy === a.id ? '…' : 'Jetzt' }}
          </button>
          <button v-if="!a.isDefault" class="btn-xs" @click="makeDefault(a)">Als Ziel</button>
          <button class="btn-xs" @click="toggle(a)">{{ a.enabled ? 'Pause' : 'Weiter' }}</button>
          <button class="btn-xs" title="Vollabgleich erzwingen" @click="resetToken(a)">
            Neu lesen
          </button>
          <button
            class="btn-xs !border-bad/40 !text-bad hover:!bg-bad hover:!text-paper"
            @click="remove(a)"
          >
            Trennen
          </button>
        </div>
        <div class="mt-1 flex flex-wrap items-center gap-4 text-xs text-muted">
          <span>{{ a.linkedEvents }} verknüpfte Termine</span>
          <label
            class="flex cursor-pointer items-center gap-1.5"
            :class="a.allowRemoteDelete ? 'text-bad' : ''"
          >
            <input type="checkbox" :checked="a.allowRemoteDelete" @change="toggleDelete(a)" />
            Löschen dort erlauben
          </label>
          <span>
            letzter Abgleich:
            {{ a.lastSyncAt ? new Date(a.lastSyncAt).toLocaleString('de-DE') : 'nie' }}
          </span>
          <span v-if="a.provider === 'GOOGLE' && !a.hasRefreshToken" class="text-warn">
            kein Refresh-Token — bitte neu verbinden
          </span>
        </div>
        <p v-if="a.lastError" class="mt-1 text-xs text-bad">{{ a.lastError }}</p>
      </li>
    </ul>
    <p v-else class="mb-6 text-sm text-muted">Noch kein Kalender verbunden.</p>

    <p v-if="data?.pendingDeletes" class="mb-6 text-xs text-warn">
      {{ data.pendingDeletes }} Löschung(en) warten auf den nächsten Abgleich.
    </p>

    <!-- Connect Google -->
    <div class="mb-6 border-t border-line pt-4">
      <h3 class="eyebrow-muted mb-2">Google Kalender</h3>
      <p v-if="!data?.googleConfigured" class="text-sm text-muted">
        GOOGLE_CLIENT_ID und GOOGLE_CLIENT_SECRET in der <code>.env</code> setzen. In der Google
        Cloud Console eine OAuth-Client-ID (Webanwendung) anlegen und als Redirect-URI genau
        <code class="border border-line bg-paper-2 px-1"
          >/api/calendar-accounts/google/callback</code
        >
        eintragen.
      </p>
      <button v-else class="btn-primary" :disabled="busy === 'google'" @click="connectGoogle">
        <span>Google-Konto verbinden</span><span aria-hidden="true">↗</span>
      </button>
    </div>

    <!-- Connect Apple -->
    <div class="border-t border-line pt-4">
      <h3 class="eyebrow-muted mb-2">Apple / iCloud</h3>
      <p class="mb-3 text-xs text-muted">
        Braucht ein <strong>app-spezifisches Passwort</strong> (appleid.apple.com → Anmeldung und
        Sicherheit → App-Passwörter). Das normale Apple-Passwort funktioniert nicht. Es wird
        verschlüsselt gespeichert und nur für den Abgleich benutzt.
      </p>

      <form class="grid gap-3 sm:grid-cols-3" @submit.prevent="discoverApple">
        <div>
          <label class="label">Apple ID</label>
          <input
            v-model="appleForm.username"
            type="email"
            class="input"
            autocomplete="off"
            required
          />
        </div>
        <div>
          <label class="label">App-Passwort</label>
          <input
            v-model="appleForm.password"
            type="password"
            class="input"
            autocomplete="new-password"
            placeholder="xxxx-xxxx-xxxx-xxxx"
            required
          />
        </div>
        <div class="flex items-end">
          <button class="btn-ghost" :disabled="busy === 'apple-discover'">
            {{ busy === 'apple-discover' ? 'Sucht …' : 'Kalender suchen' }}
          </button>
        </div>
      </form>

      <ul v-if="appleCalendars.length" class="mt-4 border-t border-line">
        <li
          v-for="cal in appleCalendars"
          :key="cal.href"
          class="flex items-center gap-3 border-b border-line py-2 text-sm"
        >
          <span class="flex-1">{{ cal.displayName }}</span>
          <span
            v-if="!cal.supportsSyncCollection"
            class="badge badge-warn"
            title="Ohne WebDAV-Sync werden Löschungen auf der Apple-Seite nicht erkannt"
          >
            kein Sync-Token
          </span>
          <button class="btn-xs" :disabled="busy === 'apple-add'" @click="addApple(cal)">
            Verbinden
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>
