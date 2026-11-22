// One's own profile, end to end against a real server, signed in with Google played by a fake `fetch`.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isHandle } from '../shared/protocol';
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
    const { handle } = (await profile(ada)) as { handle: string };
    expect(await profile(ada)).toEqual({ id, name: 'Ada', image: ADA.picture, picture: null, handle });
    expect(isHandle(handle) && handle !== id).toBe(true); // (where their page is: drawn at random, and nothing of who they are)
    expect(rows('profile')).toEqual([{ account: id, name: 'Ada', picture: null, handle }]);
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
    expect(ada.cookie).toBe(''); // (signed out in the browser too)
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

  describe('picture', () => {
    const PICTURE = '/profile/picture';
    const kept = (): string[] => (existsSync(join(dir, 'pictures')) ? readdirSync(join(dir, 'pictures')) : []);
    /** A photo as a phone takes one: a JPEG, wider than tall, with where and on what it was taken. */
    const photo = (): Promise<Buffer> =>
      sharp({ create: { width: 600, height: 400, channels: 3, background: '#c33' } })
        .jpeg()
        .withExif({ IFD0: { Make: 'Phonemaker', Model: 'Pocket 9' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 44/1 0/1' } })
        .toBuffer();

    it('is drawn afresh, small and square and with nothing of where it was taken, and served from here as only a picture', async () => {
      const ada = await signedIn(ADA);
      const sent = await photo();
      expect((await sharp(sent).metadata()).exif).toBeDefined();
      const res = await ada.ask(PICTURE, sent, { method: 'PUT' });
      expect(res.status).toBe(200);
      const { picture } = (await res.json()) as { picture: string };
      expect(picture).toMatch(/^\/pictures\/[0-9a-f]{16}\.webp$/);
      expect(await profile(ada)).toMatchObject({ picture, image: ADA.picture });

      const got = await fetch(`http://localhost:${server.port}${picture}`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toBe('image/webp');
      expect(got.headers.get('x-content-type-options')).toBe('nosniff');
      const bytes = Buffer.from(await got.arrayBuffer());
      const meta = await sharp(bytes).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 128, 128]);
      expect(meta.exif).toBeUndefined();
      expect(bytes.includes('Phonemaker')).toBe(false);
      expect(kept()).toEqual([picture.slice('/pictures/'.length)]);
    });

    it('put up again is a new address, the old one gone; taken down, none, and Google’s is left', async () => {
      const ada = await signedIn(ADA);
      const first = ((await (await ada.ask(PICTURE, await photo(), { method: 'PUT' })).json()) as { picture: string }).picture;
      const second = ((await (await ada.ask(PICTURE, await photo(), { method: 'PUT' })).json()) as { picture: string }).picture;
      expect(second).not.toBe(first);
      expect((await fetch(`http://localhost:${server.port}${first}`)).status).toBe(404);
      expect(kept()).toHaveLength(1);
      const down = await ada.ask(PICTURE, undefined, { method: 'DELETE' });
      expect(await down.json()).toMatchObject({ picture: null, image: ADA.picture });
      expect(kept()).toEqual([]);
    });

    it('takes nothing that is not a picture, nor too much, nor from nobody or another site', async () => {
      const ada = await signedIn(ADA);
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
      const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer();
      expect((await ada.ask(PICTURE, svg, { method: 'PUT' })).status).toBe(400);
      expect((await ada.ask(PICTURE, gif, { method: 'PUT' })).status).toBe(400);
      expect((await ada.ask(PICTURE, Buffer.from('<html><script>alert(1)</script>'), { method: 'PUT' })).status).toBe(400);
      // Too much is refused by its stated size, unread: the answer may close the connection before the body is all sent,
      // so the asking can fail rather than read the 413. Either way it is refused.
      const tooMuch = await ada.ask(PICTURE, Buffer.alloc(2 << 20), { method: 'PUT' }).catch(() => null);
      expect(tooMuch === null || tooMuch.status === 413).toBe(true);
      expect((await ada.ask(PICTURE, await photo(), { method: 'PUT', origin: 'https://evil.example' })).status).toBe(403);
      expect((await new Browser(server.port).ask(PICTURE, await photo(), { method: 'PUT' })).status).toBe(401);
      expect(kept()).toEqual([]);
      expect(await profile(ada)).toMatchObject({ picture: null });
      expect((await fetch(`http://localhost:${server.port}/pictures/../nertz.db`)).status).toBe(404);
      expect((await fetch(`http://localhost:${server.port}/pictures/0123456789abcdef.webp`)).status).toBe(404);
    });

    it('goes with the account', async () => {
      const ada = await signedIn(ADA);
      await ada.ask(PICTURE, await photo(), { method: 'PUT' });
      expect(kept()).toHaveLength(1);
      expect((await ada.ask('/profile', undefined, { method: 'DELETE' })).status).toBe(204);
      expect(kept()).toEqual([]);
    });
  });

  it('is made for anyone who signed up before there were profiles', async () => {
    await signedIn(ADA);
    await server.close();
    write('delete from profile');
    await start();
    expect(rows('profile')).toMatchObject([{ name: 'Ada', handle: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
  });

  it('is given a page of its own if it was made before there were pages: each its own, drawn at random', async () => {
    await signedIn(ADA);
    await signedIn(BOB);
    await server.close();
    // (The database as it was before the migration that draws them.)
    write('drop index profile_handle');
    write('alter table profile drop column handle');
    write('pragma user_version = 5');
    await start();
    const handles = rows('profile').map((p) => p.handle as string);
    expect(handles.every(isHandle)).toBe(true);
    expect(new Set(handles).size).toBe(2);
    const ada = await signedIn(ADA);
    expect(handles).toContain(((await profile(ada)) as { handle: string }).handle);
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
