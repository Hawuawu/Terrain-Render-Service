import { defineConfig } from 'vite';

export default defineConfig({
  build: { chunkSizeWarningLimit: 700 },
  server: {
    proxy: { '/voxels': 'http://localhost:8000', '/api': 'http://localhost:8000' },
  },
});
