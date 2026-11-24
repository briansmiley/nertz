import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The game server (server/index.ts) listens on 8787; in dev Vite serves the
// client on 5173 and proxies the websocket through so the client can always
// connect to `/ws` on its own origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT) || 5173, // (VITE_PORT and PORT: a second checkout can run beside the first)
    strictPort: true,
    proxy: {
      '/api/auth': `http://localhost:${Number(process.env.PORT) || 8787}`,
      '/stats': `http://localhost:${Number(process.env.PORT) || 8787}`,
      '/profile': `http://localhost:${Number(process.env.PORT) || 8787}`,
      '/pictures': `http://localhost:${Number(process.env.PORT) || 8787}`,
      '/feedback': `http://localhost:${Number(process.env.PORT) || 8787}`,
      '/usage': `http://localhost:${Number(process.env.PORT) || 8787}`,
      '/tables': `http://localhost:${Number(process.env.PORT) || 8787}`,
      '/ws': { target: `ws://localhost:${Number(process.env.PORT) || 8787}`, ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'node',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/**/*.test.ts'],
    setupFiles: ['server/testsetup.ts'], // a throw the guard catches fails the test it happened in
  },
});
