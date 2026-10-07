import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@soloops/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    watch: { usePolling: true },
    proxy: {
      // In the container the API is at http://api:3000, locally at localhost.
      '/api': { target: process.env.API_PROXY ?? 'http://api:3000', changeOrigin: true },
      // n8n under our own origin. Not a convenience: the editor only renders
      // inside the soloops iframe when it is same-origin, and its push
      // channel is a websocket, hence `ws`.
      //
      // The prefix has to be stripped. N8N_PATH only makes n8n *emit*
      // /n8n/... URLs — it still serves its assets and its REST API at the
      // root and expects the proxy in front to take the prefix off again.
      // Forwarded verbatim, every asset and every REST call lands in n8n's
      // SPA fallback instead, and the editor renders an empty page.
      '/n8n': {
        target: process.env.N8N_PROXY ?? 'http://n8n:5678',
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/n8n/, '') || '/',
      },
    },
  },
})
