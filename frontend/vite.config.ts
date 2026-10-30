import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom', 'zustand'],
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'zustand', 'zustand/middleware'],
  },
  server: {
    fs: {
      allow: ['..'],
    },
  },
})
