// The service worker (public/sw.js), run here with a network and a cache of the test's own: which answer a window gets
// for the page, for a file of the build, and for what is the server's alone.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILES = ['/', '/assets/index-Old1.js', '/cards/backs/plain.png'];
type Answer = { status: number; body: string; type?: string };
const answer = (body: string, status = 200): Answer => ({ status, body });

/** The worker, installed: `network` answers what it fetches (or throws: no network), and `cache` is what it keeps. */
function worker(network: (url: string) => Answer | Promise<Answer>) {
  const cache = new Map<string, Answer>(FILES.map((f) => [f, answer(`kept ${f}`)]));
  const handlers: Record<string, (e: never) => void> = {};
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8').replace("'__BUILD__'", "'test'").replace('__FILES__', JSON.stringify(FILES));
  const self = { location: { origin: 'https://nertz.example' }, addEventListener: (type: string, fn: (e: never) => void) => void (handlers[type] = fn), skipWaiting: async () => {}, clients: { claim: async () => {} } };
  const caches = {
    open: async () => ({ match: async (path: string) => cache.get(new URL(path, self.location.origin).pathname) }),
    keys: async () => [],
    delete: async () => true,
  };
  const asked: string[] = [];
  const fetch = async (request: { url: string }): Promise<Answer> => {
    asked.push(new URL(request.url).pathname);
    return network(request.url);
  };
  new Function('self', 'caches', 'fetch', 'Response', source)(self, caches, fetch, { error: () => answer('', 0) });
  /** What a window gets for `path`: the worker's answer, or `undefined` where it leaves the request to the network. */
  const get = async (path: string, mode = 'cors', method = 'GET'): Promise<Answer | undefined> => {
    let answered: Promise<Answer> | undefined;
    handlers.fetch!({ request: { url: new URL(path, self.location.origin).href, mode, method }, respondWith: (a: Promise<Answer>) => void (answered = Promise.resolve(a)) } as never);
    return answered;
  };
  return { get, asked };
}
const down = (): never => {
  throw new TypeError('Failed to fetch');
};

describe('the page', () => {
  it("is the network's while it answers in time, and the copy kept here once it has not: a line that hangs never says no, and the game comes up all the same", async () => {
    let arrive!: (a: Answer) => void;
    const w = worker(() => new Promise<Answer>((ok) => (arrive = ok)));
    const got = w.get('/', 'navigate');
    const first = await Promise.race([got, new Promise((ok) => setTimeout(() => ok('still waiting'), 3000))]);
    expect(first).toBe('still waiting'); // (a slow line is waited for: after a deploy the copy kept is the old build)
    expect(await got).toEqual(answer('kept /'));
    arrive(answer('the new build')); // too late for this load
    expect(await got).toEqual(answer('kept /'));
    const slow = worker(() => new Promise<Answer>((ok) => setTimeout(() => ok(answer('the new build')), 100)));
    expect(await slow.get('/?room=ABCD', 'navigate')).toEqual(answer('the new build'));
  }, 10_000);

  it('is the copy kept here with no network at all, at home, at a table named in the address, or on someone\'s page', async () => {
    const w = worker(down);
    for (const path of ['/', '/?room=ABCD', '/u/0123456789abcdef']) expect(await w.get(path, 'navigate')).toEqual(answer('kept /'));
  });

  it('is the copy kept here when the server has no answer of its own (a proxy with nothing behind it); what the server does say is what the window gets', async () => {
    expect(await worker(() => answer('Bad gateway', 502)).get('/', 'navigate')).toEqual(answer('kept /'));
    expect(await worker(() => answer('Unavailable', 503)).get('/', 'navigate')).toEqual(answer('kept /'));
    expect(await worker(() => answer('Not found', 404)).get('/', 'navigate')).toEqual(answer('Not found', 404));
  });
});

describe('everything else', () => {
  it("a file of the build is the copy kept here, never asked of the network; one not of this build is the network's", async () => {
    const w = worker(() => answer('from the network'));
    expect(await w.get('/assets/index-Old1.js')).toEqual(answer('kept /assets/index-Old1.js'));
    expect(await w.get('/cards/backs/plain.png?v=3')).toEqual(answer('kept /cards/backs/plain.png'));
    expect(w.asked).toEqual([]);
    expect(await w.get('/assets/index-New2.js')).toBeUndefined();
  });

  it("what is the server's alone is never touched: who is signed in, the tables, feedback, signing in, and the page asked for to see whether it is new", async () => {
    const w = worker(down);
    for (const path of ['/profile', '/tables', '/stats/abc', '/pictures/0123456789abcdef.webp', '/healthz']) expect(await w.get(path)).toBeUndefined();
    expect(await w.get('/', 'cors')).toBeUndefined(); // (client/net.ts `renew`: the network's page, or none)
    expect(await w.get('/api/auth/callback/google', 'navigate')).toBeUndefined();
    expect(await w.get('/feedback', 'cors', 'POST')).toBeUndefined();
  });
});
