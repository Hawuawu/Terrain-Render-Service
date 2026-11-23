import { defineConfig } from 'vite';

export default defineConfig({
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium/') },
  build: { chunkSizeWarningLimit: 5000 },
  server: {
    proxy: { '/terrain': 'http://localhost:8000', '/api': 'http://localhost:8000' },
  },
});
