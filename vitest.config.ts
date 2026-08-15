import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // The live-journey test drives the real API; unit tests mock the adapter
    // and ignore this.
    'import.meta.env.VITE_API_URL': JSON.stringify('http://localhost:5173/api-proxy'),
  },
  test: { environment: 'jsdom', globals: true },
})
