<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '@/api'
import PageHeader from '@/components/PageHeader.vue'
import { useVault, type VaultItem } from '@/stores/vault'
import { generatePassword, type Secret } from '@/lib/crypto'

type Project = { id: string; key: string }

const vault = useVault()
const projects = ref<Project[]>([])
const master = ref('')
const masterRepeat = ref('')
const error = ref('')
const query = ref('')

const editing = ref(false)
const revealed = ref<Record<string, Secret>>({})
const form = ref({
  id: '' as string | undefined,
  title: '',
  username: '',
  url: '',
  folder: '',
  tags: '',
  projectId: '',
  password: '',
  notes: '',
  totpSecret: '',
})

async function unlock() {
  error.value = ''
  if (!(await vault.unlock(master.value))) error.value = 'Master-Passwort falsch.'
  master.value = ''
}

async function setup() {
  error.value = ''
  if (master.value.length < 12) {
    error.value = 'Mindestens 12 Zeichen.'
    return
  }
  if (master.value !== masterRepeat.value) {
    error.value = 'Die Eingaben stimmen nicht überein.'
    return
  }
  await vault.setup(master.value)
  master.value = ''
  masterRepeat.value = ''
}

function newItem() {
  editing.value = true
  form.value = {
    id: undefined,
    title: '',
    username: '',
    url: '',
    folder: '',
    tags: '',
    projectId: '',
    password: generatePassword(),
    notes: '',
    totpSecret: '',
  }
}

async function edit(item: VaultItem) {
  const secret = await vault.reveal(item)
  editing.value = true
  form.value = {
    id: item.id,
    title: item.title,
    username: item.username ?? '',
    url: item.url ?? '',
    folder: item.folder ?? '',
    tags: item.tags.join(', '),
    projectId: item.projectId ?? '',
    password: secret.password ?? '',
    notes: secret.notes ?? '',
    totpSecret: secret.totpSecret ?? '',
  }
}

async function save() {
  error.value = ''
  try {
    await vault.save(
      {
        id: form.value.id,
        title: form.value.title,
        username: form.value.username || null,
        url: form.value.url || null,
        folder: form.value.folder || null,
        tags: form.value.tags.split(',').map((t) => t.trim()).filter(Boolean),
        projectId: form.value.projectId || null,
      },
      {
        password: form.value.password,
        notes: form.value.notes,
        totpSecret: form.value.totpSecret,
      },
    )
    editing.value = false
  } catch (err) {
    error.value = (err as Error).message
  }
}

async function reveal(item: VaultItem) {
  revealed.value[item.id] = await vault.reveal(item)
}

async function copyPassword(item: VaultItem) {
  const secret = revealed.value[item.id] ?? (await vault.reveal(item))
  await navigator.clipboard.writeText(secret.password ?? '')
  // Zwischenablage nach 30 s wieder leeren
  setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), 30_000)
}

async function remove(item: VaultItem) {
  if (!confirm(`"${item.title}" löschen?`)) return
  await vault.remove(item.id)
}

onMounted(async () => {
  projects.value = await api.get<Project[]>('/api/projects')
  await vault.loadMeta()
})
</script>

<template>
  <div>
    <PageHeader title="Passwörter" subtitle="Ende-zu-Ende verschlüsselt im Browser">
      <template #actions>
        <template v-if="!vault.locked">
          <button class="btn-ghost" @click="vault.lock()">Sperren</button>
          <button class="btn-primary" @click="newItem">Neuer Eintrag</button>
        </template>
      </template>
    </PageHeader>

    <!-- Ersteinrichtung -->
    <div v-if="vault.locked && !vault.initialized" class="card max-w-md">
      <h2 class="eyebrow mb-1">Vault einrichten</h2>
      <p class="mb-4 text-xs text-muted">
        Das Master-Passwort wird nirgends gespeichert. Wenn du es verlierst, sind die Einträge
        unwiederbringlich verloren — der Server kennt nur den Ciphertext.
      </p>
      <div class="space-y-3">
        <input v-model="master" type="password" class="input" placeholder="Master-Passwort" />
        <input v-model="masterRepeat" type="password" class="input" placeholder="Wiederholen" />
        <p v-if="error" class="text-sm text-bad">{{ error }}</p>
        <button class="btn-primary w-full justify-center" @click="setup">Einrichten</button>
      </div>
    </div>

    <!-- Entsperren -->
    <form v-else-if="vault.locked" class="card max-w-md" @submit.prevent="unlock">
      <h2 class="eyebrow mb-4">Vault entsperren</h2>
      <input v-model="master" type="password" class="input" placeholder="Master-Passwort" autofocus />
      <p v-if="error" class="mt-2 text-sm text-bad">{{ error }}</p>
      <button class="btn-primary mt-3 w-full justify-center">Entsperren</button>
    </form>

    <!-- Entsperrt -->
    <template v-else>
      <form v-if="editing" class="card mb-4 grid gap-3 md:grid-cols-3" @submit.prevent="save">
        <div>
          <label class="label">Titel</label>
          <input v-model="form.title" class="input" required />
        </div>
        <div>
          <label class="label">Benutzername</label>
          <input v-model="form.username" class="input" />
        </div>
        <div>
          <label class="label">URL</label>
          <input v-model="form.url" class="input" />
        </div>
        <div class="md:col-span-2">
          <label class="label">Passwort</label>
          <div class="flex gap-2">
            <input v-model="form.password" class="input font-mono" />
            <button type="button" class="btn-ghost" @click="form.password = generatePassword()">
              Würfeln
            </button>
          </div>
        </div>
        <div>
          <label class="label">TOTP-Secret</label>
          <input v-model="form.totpSecret" class="input font-mono" />
        </div>
        <div>
          <label class="label">Ordner</label>
          <input v-model="form.folder" class="input" />
        </div>
        <div>
          <label class="label">Tags</label>
          <input v-model="form.tags" class="input" />
        </div>
        <div>
          <label class="label">Projekt</label>
          <select v-model="form.projectId" class="input">
            <option value="">—</option>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
          </select>
        </div>
        <div class="md:col-span-3">
          <label class="label">Notizen</label>
          <textarea v-model="form.notes" rows="3" class="input" />
        </div>
        <div class="md:col-span-3 flex justify-end gap-2">
          <button type="button" class="btn-ghost" @click="editing = false">Abbrechen</button>
          <button class="btn-primary">Speichern</button>
        </div>
      </form>

      <input
        v-model="query"
        class="input mb-4 max-w-sm"
        placeholder="Suchen …"
        @input="vault.list(query)"
      />

      <p v-if="error" class="mb-4 text-sm text-bad">{{ error }}</p>

      <div class="border-t border-line-strong">
        <table class="table">
          <thead>
            <tr>
              <th>Titel</th>
              <th>Benutzer</th>
              <th>Passwort</th>
              <th>Ordner</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in vault.items" :key="item.id" class="hover:bg-ink/[0.035]">
              <td>
                <div>{{ item.title }}</div>
                <a v-if="item.url" :href="item.url" target="_blank" class="text-xs text-muted hover:text-blue">
                  {{ item.url }}
                </a>
              </td>
              <td class="font-mono text-xs">{{ item.username ?? '—' }}</td>
              <td class="font-mono text-xs">
                <span v-if="revealed[item.id]">{{ revealed[item.id]?.password }}</span>
                <span v-else class="text-muted">••••••••••</span>
              </td>
              <td class="text-xs text-muted">{{ item.folder ?? '—' }}</td>
              <td class="whitespace-nowrap text-right">
                <button class="btn-xs" @click="reveal(item)">Zeigen</button>
                <button class="btn-xs ml-1" @click="copyPassword(item)">Kopieren</button>
                <button class="btn-xs ml-1" @click="edit(item)">✎</button>
                <button class="btn-xs ml-1 !border-bad/40 !text-bad hover:!bg-bad hover:!text-paper" @click="remove(item)">✕</button>
              </td>
            </tr>
            <tr v-if="!vault.items.length">
              <td colspan="5" class="py-8 text-center text-muted">Vault ist leer.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
