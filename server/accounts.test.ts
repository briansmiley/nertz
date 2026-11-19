// Signing in, end to end against a real server, with Google played by a fake `fetch`: the browser's part is done by
// hand (a cookie jar, and following the redirects).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_PATH, accountsFromEnv, openAccounts } from './accounts';
import { dataFromEnv, openDb, type Db } from './db';
import { startServer, type NertzServer } from './index';
import { ACCOUNTS, ADA, Browser, fakeGoogle, rows as allRows } from './testkit';


describe('accounts', () => {
  let server: NertzServer;
  let real: typeof fetch;
  let dir: string;
  const rows = (table: string): Record<string, unknown>[] => allRows(join(dir, 'nertz.db'), table);
  const at = (path: string): string => `http://localhost:${server.port}${path}`;

  beforeEach(async () => {
    real = globalThis.fetch;
    fakeGoogle();
    dir = mkdtempSync(join(tmpdir(), 'nertz-accounts-'));
    server = await startServer({ port: 0, dist: '/nonexistent', data: join(dir, 'nertz.db'), accounts: ACCOUNTS });
    expect(server.accounts).toBe(true);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('signs someone in with Google, knows them by their cookie after, and signs them out', async () => {
    const browser = new Browser(server.port);
    expect(await (await browser.ask(`${AUTH_PATH}/get-session`)).json()).toBeNull();

    // Off to Google, which is told where to come back to; and back, to the page they left.
    const { google, back } = await browser.signIn(ADA, '/?room=ABCD');
    expect(google.origin + google.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(google.searchParams.get('client_id')).toBe('client-id');
    expect(google.searchParams.get('redirect_uri')).toBe(`${ACCOUNTS.url}${AUTH_PATH}/callback/google`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/?room=ABCD');

    const session = (await (await browser.ask(`${AUTH_PATH}/get-session`)).json()) as { user: { id: string; name: string; email: string; image: string } };
    expect(session.user).toMatchObject({ name: 'Ada Lovelace', email: 'ada@example.com', image: 'https://example.com/ada.png' });

    // Kept of them: who they are. Not where they signed in from or on what, nor Google's keys to their account.
    expect(rows('user')).toMatchObject([{ name: 'Ada Lovelace', email: 'ada@example.com' }]);
    expect(rows('session')).toMatchObject([{ ipAddress: null, userAgent: null }]);
    expect(rows('account')).toMatchObject([{ providerId: 'google', accountId: 'google-123', accessToken: null, refreshToken: null, idToken: null }]);

    // Their name and picture are Google's: not theirs to set.
    expect((await browser.ask(`${AUTH_PATH}/update-user`, { name: 'Somebody Else', image: 'https://evil.example/pixel' })).status).toBe(404);

    expect((await browser.ask(`${AUTH_PATH}/sign-out`, {})).status).toBe(200);
    expect(await (await browser.ask(`${AUTH_PATH}/get-session`)).json()).toBeNull();
  });

  it('brings whoever says no at Google back to the page they left', async () => {
    const browser = new Browser(server.port);
    const { url } = (await (await browser.ask(`${AUTH_PATH}/sign-in/social`, { provider: 'google', callbackURL: '/?room=ABCD', errorCallbackURL: '/?room=ABCD' })).json()) as { url: string };
    const back = await browser.ask(`${AUTH_PATH}/callback/google?error=access_denied&state=${encodeURIComponent(new URL(url).searchParams.get('state')!)}`);
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toMatch(/^\/\?room=ABCD&error=/);
    expect(await (await browser.ask(`${AUTH_PATH}/get-session`)).json()).toBeNull();
  });

  it('does not read a body too big to be about signing in, or of no stated size', async () => {
    const big = await real(at(`${AUTH_PATH}/sign-in/social`), { method: 'POST', headers: { origin: ACCOUNTS.url, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google', callbackURL: '/', pad: 'x'.repeat(20_000) }) });
    expect(big.status).toBe(413);
    const stream = new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode('{"provider":"google"}')), c.close()) });
    const chunked = await real(at(`${AUTH_PATH}/sign-in/social`), { method: 'POST', headers: { origin: ACCOUNTS.url, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  it('does not send anyone signing in to another site afterwards', async () => {
    const res = await new Browser(server.port).ask(`${AUTH_PATH}/sign-in/social`, { provider: 'google', callbackURL: 'https://evil.example/' });
    expect(res.status).toBe(403);
  });
});

describe('who', () => {
  let db: Db;
  afterEach(() => db.close());

  it('is nobody without a cookie, or with one nobody was given', async () => {
    db = openDb(':memory:');
    const accounts = await openAccounts(db, ACCOUNTS);
    expect(await accounts.who({})).toBeNull();
    expect(await accounts.who({ cookie: 'better-auth.session_token=made-up.signature' })).toBeNull();
  });
});

describe('with no accounts set up', () => {
  it('answers 404 where signing in would be', async () => {
    const server = await startServer({ port: 0, dist: '/nonexistent' });
    try {
      expect((await fetch(`http://localhost:${server.port}${AUTH_PATH}/get-session`)).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('the environment sets accounts up only with all of it there, and says what is not', () => {
    const all = { NODE_ENV: 'production', PUBLIC_URL: 'https://nertz.example/', AUTH_SECRET: 's', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x' };
    expect(accountsFromEnv(all)).toEqual({ url: 'https://nertz.example', secret: 's', google: { id: 'id', secret: 'x' } });
    expect(accountsFromEnv({ ...all, GOOGLE_CLIENT_SECRET: undefined })).toEqual({ missing: ['GOOGLE_CLIENT_SECRET'] });
    expect(accountsFromEnv({ ...all, AUTH_SECRET: undefined, PUBLIC_URL: undefined })).toEqual({ missing: ['AUTH_SECRET', 'PUBLIC_URL'] });
    // Outside production the app is reached at Vite's address, without saying.
    expect(accountsFromEnv({ AUTH_SECRET: 's', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'x' })).toEqual({ url: 'http://localhost:5173', secret: 's', google: { id: 'id', secret: 'x' } });
  });

  it('the environment names the database: in DATA_DIR, which outside production is ./data', () => {
    expect(dataFromEnv({ NODE_ENV: 'production', DATA_DIR: '/data' })).toBe('/data/nertz.db');
    expect(dataFromEnv({ NODE_ENV: 'production' })).toBeNull();
    expect(dataFromEnv({})).toBe('data/nertz.db');
  });

  it('the game runs without them when they cannot be opened', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nertz-accounts-'));
    writeFileSync(join(dir, 'nertz.db'), 'not a database, whatever it is called');
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const server = await startServer({ port: 0, dist: '/nonexistent', data: join(dir, 'nertz.db'), accounts: ACCOUNTS });
    try {
      expect(server.kept).toBe(false);
      expect(server.accounts).toBe(false);
      expect(said).toHaveBeenCalledWith('nothing is kept: the database could not be opened', expect.anything());
      expect((await fetch(`http://localhost:${server.port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://localhost:${server.port}${AUTH_PATH}/get-session`)).status).toBe(404);
    } finally {
      said.mockRestore();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
