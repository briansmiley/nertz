import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * The service worker (public/sw.js) is told what it is to keep, once everything is built: every file of the build by its
 * path (the page as `/`), and a name for the build made of all their contents, so that any change at all is a new worker.
 */
function serviceWorker(): Plugin {
  let out = '';
  return {
    name: 'nertz-service-worker',
    apply: 'build',
    configResolved(config) {
      out = join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = (readdirSync(out, { recursive: true, withFileTypes: true }) as import('node:fs').Dirent[])
        .filter((f) => f.isFile())
        .map((f) => join(f.parentPath, f.name))
        .filter((f) => relative(out, f) !== 'sw.js' && !f.endsWith('.map'))
        .sort();
      const build = createHash('sha256');
      for (const f of files) build.update(relative(out, f)).update(readFileSync(f));
      const paths = files.map((f) => `/${relative(out, f).split(sep).join('/')}`).map((p) => (p === '/index.html' ? '/' : p));
      const sw = join(out, 'sw.js');
      writeFileSync(sw, readFileSync(sw, 'utf8').replace("'__BUILD__'", JSON.stringify(build.digest('hex').slice(0, 16))).replace('__FILES__', JSON.stringify(paths)));
    },
  };
}

// The game server (server/index.ts) listens on 8787; in dev Vite serves the
// client on 5173 and proxies the websocket through so the client can always
// connect to `/ws` on its own origin.
export default defineConfig({
  plugins: [react(), serviceWorker()],
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
