import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the UI talks to one API instance through this proxy; in Docker, nginx serves
// the built UI and load-balances /api/* across both API instances.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3001',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
