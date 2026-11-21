// One's own profile, end to end against a real server, signed in with Google played by a fake `fetch`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstName } from './accounts';
import { startServer, type NertzServer } from './index';
import { ACCOUNTS, ADA, BOB, Browser, fakeGoogle, rows as allRows } from './testkit';

describe('profile', () => {
  let server: NertzServer;
  let dir: string;
  const file = (): string => join(dir, 'nertz.db');
  const rows = (table: string): Record<string, unknown>[] => allRows(file(), table);
  const start = async (): Promise<void> => void (server = await startServer({ port: 0, dist: '/nonexistent', data: file(), accounts: ACCOUNTS }));
  /** Writes to the database from beside the server, as nothing in the game would. */
  const write = (sql: string, ...args: (string | number | null)[]): void => {
    const db = new DatabaseSync(file());
    try {
      db.prepare(sql).run(...args);
    } finally {
      db.close();
    }
  };
  const signedIn = async (who = ADA): Promise<Browser> => {
    const browser = new Browser(server.port);
    await browser.signIn(who);
    return browser;
  };
  const profile = async (browser: Browser): Promise<unknown> => (await browser.ask('/profile')).json();

  beforeEach(async () => {
    fakeGoogle();
    dir = mkdtempSync(join(tmpdir(), 'nertz-profile-'));
    await start();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts from the first name Google gives, with Google picture', async () => {
    const ada = await signedIn(ADA);
    const id = (rows('user')[0] as { id: string }).id;
    expect(await profile(ada)).toEqual({ id, name: 'Ada', image: ADA.picture });
    expect(rows('profile')).toEqual([{ account: id, name: 'Ada' }]);
    expect(firstName('  Grace  Brewster Hopper')).toBe('Grace');
    expect(firstName('   ')).toBeNull();
  });

  it('is nobody for nobody signed in', async () => {
    expect((await new Browser(server.port).ask('/profile')).status).toBe(401);
    expect((await new Browser(server.port).ask('/profile', { name: 'Eve' }, { method: 'PUT' })).status).toBe(401);
  });

  it('takes a new name, cleaned, and keeps it through signing in again', async () => {
    const ada = await signedIn(ADA);
    const res = await ada.ask('/profile', { name: '  Countess \n of   Lovelace and more ' }, { method: 'PUT' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Countess of Lovelace' });
    expect(await profile(ada)).toMatchObject({ name: 'Countess of Lovelace' });
    // Google says who signed in, not who they are at the table.
    expect(await profile(await signedIn(ADA))).toMatchObject({ name: 'Countess of Lovelace' });
    expect(rows('user')).toMatchObject([{ name: 'Ada Lovelace' }]);
  });

  it('takes no empty name, nor one from another site', async () => {
    const ada = await signedIn(ADA);
    expect((await ada.ask('/profile', { name: ' \n ' }, { method: 'PUT' })).status).toBe(400);
    expect((await ada.ask('/profile', { name: 42 }, { method: 'PUT' })).status).toBe(400);
    expect((await ada.ask('/profile', { name: 'Pwned' }, { method: 'PUT', origin: 'https://evil.example' })).status).toBe(403);
    expect((await ada.ask('/profile', undefined, { method: 'DELETE', origin: 'https://evil.example' })).status).toBe(403);
    expect((await ada.ask('/profile', { name: 'x'.repeat(5000) }, { method: 'PUT' })).status).toBe(413);
    expect(await profile(ada)).toMatchObject({ name: 'Ada' });
  });

  it('goes with the account, which takes everything kept as theirs, and leaves the rounds they played whole and nobody’s', async () => {
    const ada = await signedIn(ADA);
    const bob = await signedIn(BOB);
    const [a, b] = rows('user').map((u) => u.id as string);
    write("insert into round (id, created_at, game, code, number, ending, ms) values (1, 0, 'g', 'ABCD', 1, 'nertz', 1000)");
    for (const [seat, account] of [
      [0, a!],
      [1, b!],
    ] as const)
      write('insert into hand (round, seat, player, name, account, played, nertz_left, delta, nertz) values (1, ?, ?, ?, ?, 0, 0, 5, 0)', seat, seat, seat ? 'Bob' : 'Ada', account);
    write("insert into report (id, created_at, kind, text, name, account) values ('r1', 0, 'bug', 'hi', 'Ada', ?)", a!);

    const gone = await ada.ask('/profile', undefined, { method: 'DELETE' });
    expect(gone.status).toBe(204);
    expect((await ada.ask('/profile')).status).toBe(401);
    expect(rows('user').map((u) => u.id)).toEqual([b]);
    expect(rows('profile').map((p) => p.account)).toEqual([b]);
    expect(rows('account').map((x) => x.userId)).toEqual([b]);
    expect(rows('session').map((x) => x.userId)).toEqual([b]);
    expect(rows('hand').map((h) => [h.name, h.account])).toEqual([
      ['', null],
      ['Bob', b],
    ]);
    expect(rows('report').map((r) => [r.name, r.account])).toEqual([[null, null]]);
    expect(await profile(bob)).toMatchObject({ name: 'Bob' });

    // Signing in with Google again is someone new.
    const again = await signedIn(ADA);
    expect(await profile(again)).toMatchObject({ name: 'Ada' });
    expect(rows('user')).toHaveLength(2);
  });

  it('is made for anyone who signed up before there were profiles', async () => {
    await signedIn(ADA);
    await server.close();
    write('delete from profile');
    await start();
    expect(rows('profile')).toMatchObject([{ name: 'Ada' }]);
  });

  it('is not there where no accounts are kept', async () => {
    const bare = await startServer({ port: 0, dist: '/nonexistent' });
    try {
      expect((await fetch(`http://localhost:${bare.port}/profile`)).status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
