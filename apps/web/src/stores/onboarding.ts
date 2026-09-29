import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api'

export type OnboardingStep = {
  id: string
  title: string
  why: string
  done: boolean
  essential: boolean
  action: { label: string; url: string } | null
  hint?: string
}

export type Onboarding = {
  dismissed: boolean
  tourSeen: boolean
  steps: OnboardingStep[]
  done: number
  total: number
  essentialDone: number
  essentialTotal: number
  next: string | null
}

export const useOnboarding = defineStore('onboarding', () => {
  const state = ref<Onboarding | null>(null)
  const tourOpen = ref(false)
  const loaded = ref(false)

  const complete = computed(() => !!state.value && state.value.done === state.value.total)
  const visible = computed(() => !!state.value && !state.value.dismissed && !complete.value)

  async function load() {
    state.value = await api.get<Onboarding>('/api/onboarding')
    loaded.value = true
    // Open the tour by itself on the very first login — after that on request.
    if (!state.value.tourSeen) tourOpen.value = true
  }

  async function dismiss(dismissed = true) {
    if (state.value) state.value.dismissed = dismissed
    await api.post('/api/onboarding/dismiss', { dismissed })
  }

  function openTour() {
    tourOpen.value = true
  }

  async function closeTour() {
    tourOpen.value = false
    if (state.value && !state.value.tourSeen) {
      state.value.tourSeen = true
      await api.post('/api/onboarding/tour-seen', { seen: true })
    }
  }

  return { state, loaded, tourOpen, complete, visible, load, dismiss, openTour, closeTour }
})
