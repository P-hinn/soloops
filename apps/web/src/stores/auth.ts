import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, setToken } from '@/api'

export type Me = { id: string; email: string; name: string; vaultReady: boolean }
export type Config = {
  companyName: string
  currency: string
  smallBusiness: boolean
  defaultTaxRate: number
  defaultHourlyRateCents: number
  features: Record<string, boolean>
}

export const useAuth = defineStore('auth', () => {
  const me = ref<Me | null>(null)
  const config = ref<Config | null>(null)
  const loading = ref(false)

  async function login(email: string, password: string) {
    const res = await api.post<{ token: string; user: Me }>('/api/auth/login', { email, password })
    setToken(res.token)
    me.value = res.user
  }

  async function load() {
    loading.value = true
    try {
      const [user, cfg] = await Promise.all([
        api.get<Me>('/api/auth/me'),
        api.get<Config>('/api/auth/config'),
      ])
      me.value = user
      config.value = cfg
    } finally {
      loading.value = false
    }
  }

  function logout() {
    setToken(null)
    me.value = null
    location.href = '/login'
  }

  return { me, config, loading, login, load, logout }
})
