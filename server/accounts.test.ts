// Signing in, end to end against a real server, with Google played by a fake `fetch`: the browser's part is done by
// hand (a cookie jar, and following the redirects).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_PATH, accountsFromEnv, openAccounts, type Accounts } from './accounts';
import { startServer, type NertzServer } from './index';

const URL_ = 'https://nertz.example';
const base = { url: URL_, secret: 'a-secret-long-enough-for-better-auth-0123456789', google: { id: 'client-id', secret: 'client-secret' } };
const options = { ...base, file: ':memory:' };

/** A JWT nobody signed: what Google's token endpoint answers with is read, not verified (it came over TLS from Google). */
const idToken = (claims: object): string => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;

/** Cookies kept between requests, as a browser would. */
class Jar {
  private readonly kept = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      const [name, value] = [pair!.slice(0, eq), pair!.slice(eq + 1)];
      if (/max-age=0/i.test(line) || !value) this.kept.delete(name);
      else this.kept.set(name, value);
    }
  }
  get header(): string {
    return [...this.kept].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

describe('accounts', () => {
  let server: NertzServer;
  let real: typeof fetch;
  let dir: string;
  /** The rows of a table of the database, read from beside the server. */
  const rows = (table: string): Record<string, unknown>[] => {
    const db = new DatabaseSync(join(dir, 'nertz.db'), { readOnly: true });
    try {
      return db.prepare(`select * from ${table}`).all() as Record<string, unknown>[];
    } finally {
      db.close();
    }
  };
  const at = (path: string): string => `http://localhost:${server.port}${path}`;

  beforeEach(async () => {
    real = globalThis.fetch;
    // Google: any code is good, and is this person's.
    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (!url.startsWith('https://oauth2.googleapis.com/token')) return real(input, init);
      const id_token = idToken({ iss: 'https://accounts.google.com', aud: 'client-id', sub: 'google-123', email: 'ada@example.com', email_verified: true, name: 'Ada Lovelace', picture: 'https://example.com/ada.png', exp: Math.floor(Date.now() / 1000) + 3600 });
      return Response.json({ access_token: 'at', id_token, token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile' });
    }) as typeof fetch);
    dir = mkdtempSync(join(tmpdir(), 'nertz-accounts-'));
    server = await startServer({ port: 0, dist: '/nonexistent', accounts: { ...base, file: join(dir, 'nertz.db') } });
    expect(server.accounts).toBe(true);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A browser's request: with the jar's cookies, from the app's own pages, redirects not followed. */
  const ask = async (jar: Jar, path: string, body?: object): Promise<Response> => {
    const res = await real(at(path), {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: { cookie: jar.header, origin: URL_, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    jar.take(res);
    return res;
  };

  it('signs someone in with Google, knows them by their cookie after, and signs them out', async () => {
    const jar = new Jar();
    expect(await (await ask(jar, `${AUTH_PATH}/get-session`)).json()).toBeNull();

    // Off to Google, which is told where to come back to...
    const { url } = (await (await ask(jar, `${AUTH_PATH}/sign-in/social`, { provider: 'google', callbackURL: '/?room=ABCD' })).json()) as { url: string };
    const google = new URL(url);
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google.searchParams.get('client_id')).toBe('client-id');
    expect(google.searchParams.get('redirect_uri')).toBe(`${URL_}${AUTH_PATH}/callback/google`);

    // ...and back, to the page they left.
    const back = await ask(jar, `${AUTH_PATH}/callback/google?code=any&state=${encodeURIComponent(google.searchParams.get('state')!)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/?room=ABCD');

    const session = (await (await ask(jar, `${AUTH_PATH}/get-session`)).json()) as { user: { id: string; name: string; email: string; image: string } };
    expect(session.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', image: 'https://example.com/ada.png' });

    // Kept of them: who they are. Not where they signed in from or on what, nor Google's keys to their account.
    expect(rows('user')).toMatchObject([{ name: 'Ada Lovelace', email: 'ada@example.com' }]);
    expect(rows('session')).toMatchObject([{ ipAddress: null, userAgent: null }]);
    expect(rows('account')).toMatchObject([{ providerId: 'google', accountId: 'google-123', accessToken: null, refreshToken: null, idToken: null }]);

    // Their name and picture are Google's: not theirs to set.
    expect((await ask(jar, `${AUTH_PATH}/update-user`, { name: 'Somebody Else', image: 'https://evil.example/pixel' })).status).toBe(404);

    expect((await ask(jar, `${AUTH_PATH}/sign-out`, {})).status).toBe(200);
    expect(await (await ask(jar, `${AUTH_PATH}/get-session`)).json()).toBeNull();
  });

  it('brings whoever says no at Google back to the page they left', async () => {
    const jar = new Jar();
    const { url } = (await (await ask(jar, `${AUTH_PATH}/sign-in/social`, { provider: 'google', callbackURL: '/?room=ABCD', errorCallbackURL: '/?room=ABCD' })).json()) as { url: string };
    const back = await ask(jar, `${AUTH_PATH}/callback/google?error=access_denied&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toMatch(/^\/\?room=ABCD&error=/);
    expect(await (await ask(jar, `${AUTH_PATH}/get-session`)).json()).toBeNull();
  });

  it('does not read a body too big to be about signing in, or of no stated size', async () => {
    const big = await real(at(`${AUTH_PATH}/sign-in/social`), { method: 'POST', headers: { origin: URL_, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google', callbackURL: '/', pad: 'x'.repeat(20_000) }) });
    expect(big.status).toBe(413);
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode('{"provider":"google"}')), c.close()) });
    const chunked = await real(at(`${AUTH_PATH}/sign-in/social`), { method: 'POST', headers: { origin: URL_, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it('does not send anyone signing in to another site afterwards', async () => {
    const res = await ask(new Jar(), `${AUTH_PATH}/sign-in/social`, { provider: 'google', callbackURL: 'https://evil.example/' });
    expect(res.status).toBe(403);
  });
});

describe('who', () => {
  let accounts: Accounts;
  afterEach(() => accounts.close());

  it('is nobody without a cookie, or with one nobody was given', async () => {
    accounts = await openAccounts(options);
    expect(await accounts.who({})).toBeNull();
    expect(await accounts.who({ cookie: 'better-auth.session_token=made-up.signature' })).toBeNull();
  });
});

describe('with no accounts set up', () => {
  it('answers 404 where signing in would be', async () => {
    const server = await startServer({ port: 0, dist: '/nonexistent', accounts: null });
    try {
      expect((await fetch(`http://localhost:${server.port}${AUTH_PATH}/get-session`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('the environment sets accounts up only with all of it there, and says what is not', () => {
    const all = { NODE_ENV: 'production', DATA_DIR: '/data', PUBLIC_URL: 'https://nertz.example/', AUTH_SECRET: 's', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x' };
    expect(accountsFromEnv(all)).toEqual({ file: '/data/nertz.db', url: 'https://nertz.example', secret: 's', google: { id: 'id', secret: 'x' } });
    expect(accountsFromEnv({ ...all, GOOGLE_CLIENT_SECRET: undefined })).toEqual({ missing: ['GOOGLE_CLIENT_SECRET'] });
    expect(accountsFromEnv({ ...all, DATA_DIR: undefined, PUBLIC_URL: undefined })).toEqual({ missing: ['PUBLIC_URL', 'DATA_DIR'] });
    // Outside production there is somewhere to keep them, and a place the app is reached, without saying.
    expect(accountsFromEnv({ AUTH_SECRET: 's', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x' })).toEqual({ file: 'data/nertz.db', url: 'http://localhost:5173', secret: 's', google: { id: 'id', secret: 'x' } });
  });

  it('the game runs without them when they cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nertz-accounts-'));
    writeFileSync(join(dir, 'nertz.db'), 'not a database, whatever it is called');
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await startServer({ port: 0, dist: '/nonexistent', accounts: { ...base, file: join(dir, 'nertz.db') } });
    try {
      expect(server.accounts).toBe(false);
      expect(said).toHaveBeenCalledWith('accounts are off: they could not be opened', expect.anything());
      expect((await fetch(`http://localhost:${server.port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://localhost:${server.port}${AUTH_PATH}/get-session`)).status).toBe(404);
    } finally {
      said.mockRestore();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
