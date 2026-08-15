import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    // The sandbox preview reaches this server through a proxy on an external
    // hostname. Vite's default host check rejects that with a 403
    // "Blocked request", so the proxied host must be allowed explicitly.
    allowedHosts: true,
    // Route API calls to the backend so the whole app is reachable on one
    // port — the preview only exposes a single port.
    proxy: {
      '/api-proxy': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api-proxy/, ''),
      },
    },
  },
  preview: {
    host: true,
    port: 5173,
    allowedHosts: true,
  },
})
