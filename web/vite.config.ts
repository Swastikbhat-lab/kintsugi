import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // The dashboard is served by the API host in production; in dev we proxy
    // so the SSE stream and the page share an origin.
    proxy: {
      '/api': {
        target: 'http://localhost:4180',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
