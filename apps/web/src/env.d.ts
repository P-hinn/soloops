/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}

/**
 * Inside the macOS app the interface may call three native commands — see
 * apps/desktop/src-tauri/capabilities/claude.json. In the browser the object
 * is simply absent.
 */
interface Window {
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> }
  }
}
