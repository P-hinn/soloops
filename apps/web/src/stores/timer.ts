import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api } from '@/api'

export type RunningTimer = {
  id: string
  projectId: string
  description: string
  billable: boolean
  startedAt: string
  project: { id: string; key: string; name: string; color: string }
} | null

/** Zuletzt bebuchtes Projekt — der Timer startet fast immer auf demselben. */
const LAST_PROJECT = 'soloops.lastProjectId'

/** Ein globaler Timer, überall in der App sichtbar. */
export const useTimer = defineStore('timer', () => {
  const running = ref<RunningTimer>(null)
  const now = ref(Date.now())
  let ticker: ReturnType<typeof setInterval> | null = null

  const elapsedSec = computed(() => {
    if (!running.value) return 0
    return Math.max(0, Math.floor((now.value - new Date(running.value.startedAt).getTime()) / 1000))
  })

  const display = computed(() => {
    const s = elapsedSec.value
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  })

  async function refresh() {
    running.value = await api.get<RunningTimer>('/api/time/running')
  }

  async function start(projectId: string, description = '', billable = true) {
    running.value = await api.post<NonNullable<RunningTimer>>('/api/time/start', {
      projectId,
      description,
      billable,
    })
    localStorage.setItem(LAST_PROJECT, projectId)
  }

  async function stop() {
    if (!running.value) return
    await api.post('/api/time/stop', {})
    running.value = null
  }

  /** Beschreibung nachziehen, während die Uhr läuft. */
  async function describe(description: string) {
    if (!running.value) return
    await api.patch(`/api/time/${running.value.id}`, { description })
    running.value = { ...running.value, description }
  }

  /**
   * Versehentlich gestartet: Eintrag stoppen und gleich löschen, statt eine
   * Zwei-Sekunden-Buchung in der Auswertung stehen zu lassen.
   */
  async function discard() {
    if (!running.value) return
    const id = running.value.id
    running.value = null
    await api.post('/api/time/stop', { id }).catch(() => {})
    await api.del(`/api/time/${id}`)
  }

  function lastProjectId(): string | null {
    return localStorage.getItem(LAST_PROJECT)
  }

  function startTicking() {
    ticker ??= setInterval(() => (now.value = Date.now()), 1000)
  }

  return {
    running,
    elapsedSec,
    display,
    refresh,
    start,
    stop,
    describe,
    discard,
    lastProjectId,
    startTicking,
  }
})
