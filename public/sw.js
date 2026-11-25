// The service worker: what lets the game load, and be played offline (client/local.ts), with no network at all.
//
// It keeps a copy of the whole built app (`FILES`: the page, its scripts and styles, the cards, the sounds, the icons),
// taken when it is installed, and of the fonts the page asks Google for. The build writes `BUILD` and `FILES` in
// (vite.config.ts); this file is not run from the dev server.
//
// - The page itself is asked of the network first, so a window online always has the newest: only with no network, or
//   none that answers in a few seconds, is it the copy kept here.
// - A file of the app is the copy kept here (those of one build never change), else the network's.
// - Anything else of the server's (who is signed in, records, pictures, the tables, feedback, the game's socket) is
//   never touched: it is the network's to answer or not.
// A new build is a new worker with a cache of its own, which takes over at once and drops the old one's.
const BUILD = '__BUILD__';
const FILES = __FILES__;
const CACHE = `nertz-${BUILD}`;
const FONTS = 'nertz-fonts';
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];
/** How long the network has to answer for the page before the copy kept here is shown instead. */
const PAGE_MS = 3000;

/** The fonts the page asks for: its stylesheet at Google, and every file that names. As many as can be had; none is needed to play. */
async function keepFonts(page) {
  const sheet = /href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/.exec(await page.text())?.[1]?.replaceAll('&amp;', '&');
  if (!sheet) return;
  const fonts = await caches.open(FONTS);
  const css = await fetch(sheet);
  if (!css.ok) return;
  const files = [...(await css.clone().text()).matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]);
  await fonts.put(sheet, css);
  await Promise.allSettled(files.map(async (url) => (await fonts.match(url)) || fonts.add(url)));
}

self.addEventListener('install', (e) =>
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // (Past the browser's own cache, but for what Vite names by its contents: a card back keeps its name when it is drawn anew.)
      await cache.addAll(FILES.map((f) => new Request(f, { cache: f.startsWith('/assets/') ? 'default' : 'reload' })));
      await keepFonts(await cache.match('/')).catch(() => {});
      await self.skipWaiting();
    })(),
  ),
);

self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith('nertz-') && name !== CACHE && name !== FONTS) await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);

const kept = async (path) => (await caches.open(CACHE)).match(path, { ignoreSearch: true });

/** The page: the network's, if it answers in time; else the one kept here. */
async function page(request) {
  const fresh = fetch(request);
  const late = new Promise((done) => setTimeout(done, PAGE_MS));
  try {
    const first = await Promise.race([fresh, late]);
    if (first) return first;
  } catch {
    // no network
  }
  fresh.catch(() => {});
  return (await kept('/')) ?? fresh;
}

/** A font: the one kept, else the network's (kept from then on). */
async function font(request) {
  const fonts = await caches.open(FONTS);
  const had = await fonts.match(request.url, { ignoreVary: true });
  if (had) return had;
  const got = await fetch(request);
  if (got.ok || got.type === 'opaque') void fonts.put(request.url, got.clone());
  return got;
}

self.addEventListener('fetch', (e) => {
  const request = e.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (FONT_HOSTS.includes(url.hostname)) return e.respondWith(font(request));
  if (url.origin !== self.location.origin) return;
  // The app's own pages: home (with or without a table's code) and someone's page. Not a file, nor anything the server answers itself (signing in comes back through `/api/auth`).
  if (request.mode === 'navigate' && (url.pathname === '/' || url.pathname.startsWith('/u/'))) return e.respondWith(page(request));
  if (url.pathname !== '/' && FILES.includes(url.pathname)) return e.respondWith(kept(url.pathname).then((had) => had ?? fetch(request)));
});
