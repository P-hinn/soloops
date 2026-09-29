import { onScopeDispose } from 'vue'

/**
 * Keep a view in step with the data without a page reload.
 *
 * Reloads on an interval while the tab is in the foreground, pauses when it
 * moves to the background — nobody is watching there, and coming back
 * refreshes anyway — and reloads at once on return: a laptop opened after
 * lunch must not show the state from before it.
 *
 * Returns `refresh` so a view can trigger the same reload by hand.
 */
export function useLiveRefresh(reload: () => unknown, everyMs = 30_000) {
  let ticker: ReturnType<typeof setInterval> | null = null
  let inFlight = false

  /** Never stack requests: a slow reload must not queue up behind itself. */
  async function refresh() {
    if (inFlight) return
    inFlight = true
    try {
      await reload()
    } catch {
      // A failed refresh keeps what is on screen; the next tick tries again.
    } finally {
      inFlight = false
    }
  }

  function start() {
    ticker ??= setInterval(refresh, everyMs)
  }

  function stop() {
    if (ticker) clearInterval(ticker)
    ticker = null
  }

  function onVisibility() {
    if (document.hidden) return stop()
    void refresh()
    start()
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', refresh)
  if (!document.hidden) start()

  onScopeDispose(() => {
    stop()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', refresh)
  })

  return { refresh }
}
