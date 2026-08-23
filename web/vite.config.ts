import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': r('./src'),
      '@shared': r('../shared'),
    },
  },
  server: {
    host: '127.0.0.1', // vite defaults to 'localhost', which Node resolves to ::1 only on Windows
    port: 5273,
    strictPort: true, // fail loudly instead of drifting to 5274 and stealing the server's port
    proxy: {
      '/api': { target: 'http://127.0.0.1:5274', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:5274', ws: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
