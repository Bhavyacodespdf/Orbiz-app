/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In development the browser only talks to Vite (localhost:5173). Vite forwards
// /api and /socket.io to the Express backend, so cookies stay same-origin.
const backendUrl = process.env.CAMPUSCART_BACKEND_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: backendUrl, changeOrigin: false },
      '/socket.io': { target: backendUrl, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'], // Playwright specs in e2e/ run separately
    css: false,
  },
});
