/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dev server proxies /api to the PayFlow API (port 3100), so the browser sees one origin.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Charts are the heaviest dependency; keep them out of the entry chunk so login/first paint stays small.
        manualChunks: { charts: ['recharts'], react: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'] },
      },
    },
  },
  server: { port: 5173, proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://localhost:3100' } },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test/setup.ts'], css: false },
});
