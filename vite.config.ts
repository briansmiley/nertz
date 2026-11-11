import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The game server (server/index.ts) listens on 8787; in dev Vite serves the
// client on 5173 and proxies the websocket through so the client can always
// connect to `/ws` on its own origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/**/*.test.ts'],
  },
});
