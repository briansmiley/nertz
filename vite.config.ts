import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Names the build in its page, `<meta name="build" content="…">`: a hash of everything it serves. That is the page
 * as built, which names the bundle's files by their fingerprints, and the files copied from public/ (the icons, the
 * cards), which have none. A window left open over a deploy compares it with the page the server serves now (`renew`
 * in client/net.ts), so a change to an icon alone reloads it too.
 */
function buildId(): Plugin {
  let publicDir = '';
  return {
    name: 'nertz:build-id',
    apply: 'build',
    configResolved: (config) => void (publicDir = config.publicDir),
    transformIndexHtml: {
      order: 'post',
      handler: (html) => {
        const hash = createHash('sha256').update(html);
        const files = publicDir ? readdirSync(publicDir, { recursive: true, withFileTypes: true }) : [];
        for (const file of files.filter((f) => f.isFile()).map((f) => join(f.parentPath, f.name)).sort())
          hash.update(file.slice(publicDir.length)).update(readFileSync(file));
        return [{ tag: 'meta', attrs: { name: 'build', content: hash.digest('hex').slice(0, 12) }, injectTo: 'head' }];
      },
    },
  };
}

// The game server (server/index.ts) listens on 8787; in dev Vite serves the
// client on 5173 and proxies the websocket through so the client can always
// connect to `/ws` on its own origin.
export default defineConfig({
  plugins: [react(), buildId()],
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
