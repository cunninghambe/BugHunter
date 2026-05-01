import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5790,
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:5791',
      '/slow.png': 'http://127.0.0.1:5791',
    },
  },
  build: {
    // Force a large initial chunk to trigger oversized_bundle detection.
    chunkSizeWarningLimit: 10000,
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
