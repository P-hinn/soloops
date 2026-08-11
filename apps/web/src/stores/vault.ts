import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/api'
import {
  buildVaultCheck,
  decryptJson,
  deriveKey,
  encryptJson,
  randomSalt,
  verifyVaultCheck,
  type Secret,
} from '@/lib/crypto'

export type VaultItem = {
  id: string
  title: string
  username: string | null
  url: string | null
  folder: string | null
  tags: string[]
  cipherText: string
  iv: string
  projectId: string | null
  updatedAt: string
}

/**
 * Der Schlüssel lebt nur im Speicher dieser Session. Reload = neu entsperren.
 * Das ist Absicht: kein Key in localStorage.
 */
export const useVault = defineStore('vault', () => {
  const key = ref<CryptoKey | null>(null)
  const items = ref<VaultItem[]>([])
  const locked = ref(true)
  const initialized = ref(false)

  async function loadMeta() {
    const meta = await api.get<{ vaultSalt: string | null; vaultCheck: string | null }>(
      '/api/auth/vault-meta',
    )
    initialized.value = !!meta.vaultSalt
    return meta
  }

  async function setup(masterPassword: string) {
    const salt = randomSalt()
    const derived = await deriveKey(masterPassword, salt)
    await api.post('/api/auth/vault-meta', {
      vaultSalt: salt,
      vaultCheck: await buildVaultCheck(derived),
    })
    key.value = derived
    locked.value = false
    initialized.value = true
    await list()
  }

  async function unlock(masterPassword: string): Promise<boolean> {
    const meta = await loadMeta()
    if (!meta.vaultSalt || !meta.vaultCheck) return false
    const derived = await deriveKey(masterPassword, meta.vaultSalt)
    if (!(await verifyVaultCheck(derived, meta.vaultCheck))) return false
    key.value = derived
    locked.value = false
    await list()
    return true
  }

  function lock() {
    key.value = null
    locked.value = true
    items.value = []
  }

  async function list(query?: string) {
    items.value = await api.get<VaultItem[]>('/api/vault', { q: query })
  }

  async function reveal(item: VaultItem): Promise<Secret> {
    if (!key.value) throw new Error('Vault ist gesperrt')
    return decryptJson<Secret>(key.value, item.cipherText, item.iv)
  }

  async function save(
    meta: Omit<VaultItem, 'id' | 'cipherText' | 'iv' | 'updatedAt'> & { id?: string },
    secret: Secret,
  ) {
    if (!key.value) throw new Error('Vault ist gesperrt')
    const payload = { ...meta, ...(await encryptJson(key.value, secret)) }
    if (meta.id) await api.patch(`/api/vault/${meta.id}`, payload)
    else await api.post('/api/vault', payload)
    await list()
  }

  async function remove(id: string) {
    await api.del(`/api/vault/${id}`)
    await list()
  }

  return { key, items, locked, initialized, loadMeta, setup, unlock, lock, list, reveal, save, remove }
})
