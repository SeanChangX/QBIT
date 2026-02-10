import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyTarget = process.env.VITE_PROXY_TARGET || 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': proxyTarget,
      '/auth': proxyTarget,
      '/socket.io': {
        target: proxyTarget,
        ws: true,
      },
      '/device': {
        target: proxyTarget,
        ws: true,
      },
    },
  },
});
