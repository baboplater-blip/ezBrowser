import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  root: 'app/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'app/renderer'),
      '@shared': path.resolve(__dirname, 'app/shared'),
    },
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: false,
    target: 'chrome130',
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
