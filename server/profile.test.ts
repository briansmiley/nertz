// One's own profile, end to end against a real server, signed in with Google played by a fake `fetch`.
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import sharp from 'sharp';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAWN_HANDLE_LENGTH, firstName, giveHandle, HANDLE_ALPHABET, handleFrom, handlesFor, NAMED_TRIES, RESERVED_HANDLES } from './accounts';
import { openDb } from './db';
import { startServer, type NertzServer } from './index';
import { ACCOUNTS, ADA, BOB, Browser, fakeGoogle, rows as allRows, type Googler } from './testkit';

/** A handle as one is drawn: `k3f9x2`. */
const DRAWN = new RegExp(`^[${HANDLE_ALPHABET}]{${DRAWN_HANDLE_LENGTH}}$`);

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
    expect(await profile(ada)).toEqual({ id, name: 'Ada', image: ADA.picture, picture: null, handle: 'ada', private: false });
    expect(handle).not.toBe(id); // (where their page is: their name's, never who they are signed in as)
    expect(rows('profile')).toEqual([{ account: id, name: 'Ada', picture: null, handle: 'ada', private: 0, handle_chosen: 0 }]);
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

  it('makes your page private, and anyone\'s signed in again; kept through signing in again, the name left as it was', async () => {
    const ada = await signedIn(ADA);
    const on = await ada.ask('/profile', { private: true }, { method: 'PUT' });
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ name: 'Ada', private: true });
    expect(await profile(await signedIn(ADA))).toMatchObject({ name: 'Ada', private: true });
    expect(rows('profile')).toMatchObject([{ private: 1 }]);
    // Both at once, or either alone.
    expect(await (await ada.ask('/profile', { name: 'Countess', private: false }, { method: 'PUT' })).json()).toMatchObject({ name: 'Countess', private: false });
    expect(await profile(ada)).toMatchObject({ name: 'Countess', private: false });
    // Nothing that is not a yes or a no, nothing at all, and nothing from another site; and a bad half spoils the whole.
    for (const said of [{ private: 'yes' }, { private: 1 }, { private: null }, {}, { name: 'Ada', private: 'no' }, { name: '', private: true }])
      expect((await ada.ask('/profile', said, { method: 'PUT' })).status).toBe(400);
    expect((await ada.ask('/profile', { private: true }, { method: 'PUT', origin: 'https://evil.example' })).status).toBe(403);
    expect((await new Browser(server.port).ask('/profile', { private: true }, { method: 'PUT' })).status).toBe(401);
    expect(await profile(ada)).toMatchObject({ name: 'Countess', private: false });
  });

  describe('handle', () => {
    const handleOf = async (browser: Browser): Promise<string> => ((await profile(browser)) as { handle: string }).handle;
    const claim = (browser: Browser, handle: unknown): Promise<Response> => browser.ask('/profile', { handle }, { method: 'PUT' });
    const page = async (browser: Browser, handle: string): Promise<number> => (await browser.ask(`/stats/${handle}`)).status;

    it('is yours to choose: kept in lower case, the old one free and leading nowhere', async () => {
      const ada = await signedIn(ADA);
      const bob = await signedIn(BOB);
      const drawn = await handleOf(ada);
      const res = await claim(ada, 'Ada-Lovelace');
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ name: 'Ada', handle: 'ada-lovelace' });
      expect(await handleOf(await signedIn(ADA))).toBe('ada-lovelace');
      expect(rows('profile').map((p) => p.handle)).toContain('ada-lovelace');
      expect(await page(bob, 'ada-lovelace')).toBe(200);
      expect(await page(bob, 'ADA-Lovelace')).toBe(200); // (an address in any case)
      expect(await page(bob, drawn)).toBe(404);
      // The old one is anyone's now; one's own again is no change; and with the name, both or neither.
      expect((await claim(bob, drawn)).status).toBe(200);
      expect(await page(ada, drawn)).toBe(200);
      expect((await claim(ada, 'ada-lovelace')).status).toBe(200);
      expect(await (await ada.ask('/profile', { name: 'Countess', handle: 'countess' }, { method: 'PUT' })).json()).toMatchObject({ name: 'Countess', handle: 'countess' });
    });

    it('is 3 to 20 letters and digits, with single hyphens between them', async () => {
      const ada = await signedIn(ADA);
      for (const ok of ['abc', 'a-b', '20-chars-is-the-most', 'k3f9x2', '1a868b3c47fd956d', 'x-1-y-2']) expect((await claim(ada, ok)).status).toBe(200);
      for (const bad of ['ab', 'twenty-one-chars-long', '-abc', 'abc-', 'a--b', 'a b', 'a_b', 'ä-b', 'a.b', '', 12345, null, 'abc/def'])
        expect((await claim(ada, bad)).status).toBe(400);
      expect(await handleOf(ada)).toBe('x-1-y-2');
      // A bad handle spoils the whole: the name with it is not changed.
      expect((await ada.ask('/profile', { name: 'Countess', handle: 'a' }, { method: 'PUT' })).status).toBe(400);
      expect(await profile(ada)).toMatchObject({ name: 'Ada', handle: 'x-1-y-2' });
    });

    it('is not one someone else has, nor one the site keeps for itself: 409, and nothing changed', async () => {
      const ada = await signedIn(ADA);
      const bob = await signedIn(BOB);
      expect((await claim(bob, 'bob')).status).toBe(200);
      const had = await handleOf(ada);
      expect((await claim(ada, 'bob')).status).toBe(409);
      expect((await claim(ada, 'BOB')).status).toBe(409);
      for (const kept of ['admin', 'api', 'nertz', 'settings', 'help', 'support', 'about', 'privacy', 'null', 'undefined', 'Admin']) expect((await claim(ada, kept)).status).toBe(409);
      expect((await ada.ask('/profile', { name: 'Countess', handle: 'bob' }, { method: 'PUT' })).status).toBe(409);
      expect(await profile(ada)).toMatchObject({ name: 'Ada', handle: had });
      expect(RESERVED_HANDLES.has('k3f9x2')).toBe(false);
    });

    it('keeps a private page hidden from anyone else, by the handle it had and the one it has', async () => {
      const ada = await signedIn(ADA);
      const bob = await signedIn(BOB);
      const drawn = await handleOf(bob);
      await bob.ask('/profile', { private: true }, { method: 'PUT' });
      expect(await page(ada, drawn)).toBe(404);
      expect((await claim(bob, 'bob')).status).toBe(200);
      expect(await page(ada, 'bob')).toBe(404);
      expect(await page(ada, drawn)).toBe(404);
      expect(await page(bob, 'bob')).toBe(200); // (still its own)
    });

    it('is the next one on a clash with one someone has: the next count, or drawn again', () => {
      const db = openDb(':memory:');
      const made = db.prepare('insert into profile (account, handle) values (?, ?)');
      const of = (account: string): unknown => (db.prepare('select handle from profile where account = ?').get(account) as { handle: string }).handle;
      made.run('a', 'k3f9x2');
      const draws = ['k3f9x2', 'k3f9x2', 'm4p7q8'];
      giveHandle((handle) => made.run('b', handle), handlesFor(null, () => draws.shift()!));
      expect(of('b')).toBe('m4p7q8');
      made.run('c', 'ada');
      made.run('d', 'ada-2');
      giveHandle((handle) => made.run('e', handle), handlesFor('Ada'));
      expect(of('e')).toBe('ada-3');
      expect(() => giveHandle((handle) => made.run('f', handle), handlesFor(null, () => 'k3f9x2'))).toThrow(/UNIQUE/); // (not for ever)
      expect(() => giveHandle(() => made.run('a', 'zzzzzz'), handlesFor('Zed'))).toThrow(/UNIQUE/); // (nor for anything else)
      db.close();
    });

    it('is made from the name: lower case, accents dropped, anything else one hyphen, cut to twenty', () => {
      expect(handleFrom('Ada')).toBe('ada');
      expect(handleFrom('  Zoë  ')).toBe('zoe');
      expect(handleFrom('José María')).toBe('jose-maria');
      expect(handleFrom("D'Arcy O'Neil")).toBe('d-arcy-o-neil');
      expect(handleFrom('Ünïcödé--Fan!!')).toBe('unicode-fan');
      expect(handleFrom('Anastasia Romanova The Second')).toBe('anastasia-romanova-t'); // (twenty)
      expect(handleFrom('Anastasia Romanovas Cat')).toBe('anastasia-romanovas'); // (no hyphen left at the end)
      expect(handleFrom('R2-D2')).toBe('r2-d2');
      for (const none of ['李', '🃏', '---', '']) expect(handleFrom(none)).toBeNull();
      /** The first `n` handles tried for `name` (there is no end to them). */
      const first = (name: string | null, n: number): string[] => {
        const tried: string[] = [];
        for (const handle of handlesFor(name, () => 'drawn1')) if (tried.push(handle) >= n) break;
        return tried;
      };
      expect(first('Ada', 3)).toEqual(['ada', 'ada-2', 'ada-3']);
      expect(first('Anastasia Romanova The Second', 2)).toEqual(['anastasia-romanova-t', 'anastasia-romanova-2']);
      expect(first('Al', 2)).toEqual(['al', 'al-2']); // (`al` is too short to be one: `giveHandle` passes it by)
      expect(first('李', 2)).toEqual(['drawn1', 'drawn1']);
      expect(first(null, 1)).toEqual(['drawn1']);
      expect(first('Ada', NAMED_TRIES + 1).slice(-2)).toEqual([`ada-${NAMED_TRIES}`, 'drawn1']);
      expect(HANDLE_ALPHABET).not.toMatch(/[01ilo]/); // (nothing drawn easily taken for something else)
    });

    it('is made from the name Google gives: the next count on a clash, never one the site keeps, drawn for a name with nothing to make one', async () => {
      const people: Googler[] = [ADA, { sub: 'g-2', email: 'ada2@example.com', name: 'Ada King' }, { sub: 'g-3', email: 'adm@example.com', name: 'Admin Person' }, { sub: 'g-4', email: 'al@example.com', name: 'Al' }, { sub: 'g-5', email: 'zoe@example.com', name: 'Zoë Q' }, { sub: 'g-6', email: 'li@example.com', name: '李' }];
      fakeGoogle(people);
      const handles: string[] = [];
      for (const who of people) handles.push(await handleOf(await signedIn(who)));
      expect(handles.slice(0, 5)).toEqual(['ada', 'ada-2', 'admin-2', 'al-2', 'zoe']);
      expect(handles[5]).toMatch(DRAWN);
      expect(rows('profile').every((p) => p.handle_chosen === 0)).toBe(true);
      // And it stays where it was made as the name changes.
      const ada = await signedIn(ADA);
      expect(await (await ada.ask('/profile', { name: 'Countess' }, { method: 'PUT' })).json()).toMatchObject({ name: 'Countess', handle: 'ada' });
    });

    it('chosen, is theirs for good: marked so, and never made for them again', async () => {
      const ada = await signedIn(ADA);
      expect((await claim(ada, 'lovelace')).status).toBe(200);
      expect(rows('profile')).toMatchObject([{ handle: 'lovelace', handle_chosen: 1 }]);
      write('update profile set name = null'); // (as if it had none yet: still not made afresh, once chosen)
      expect(await (await ada.ask('/profile', { name: 'Ada' }, { method: 'PUT' })).json()).toMatchObject({ name: 'Ada', handle: 'lovelace' });
      expect(rows('profile')).toMatchObject([{ handle: 'lovelace', handle_chosen: 1 }]);
    });

    it('still leads to pages whose handles were drawn the old way, as sixteen hex digits', async () => {
      const ada = await signedIn(ADA);
      const bob = await signedIn(BOB);
      write("update profile set handle = '1a868b3c47fd956d' where account = (select id from \"user\" where email = ?)", BOB.email);
      expect(await page(ada, '1a868b3c47fd956d')).toBe(200);
      expect(await handleOf(bob)).toBe('1a868b3c47fd956d');
    });
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

  it('takes a change sent with no size said (as over HTTP/2, or chunked through a proxy), and still not too much of one', async () => {
    const ada = await signedIn(ADA);
    const unsized = (said: object): Promise<Response | null> =>
      fetch(`http://localhost:${server.port}/profile`, { method: 'PUT', headers: { cookie: ada.cookie, origin: ACCOUNTS.url, 'content-type': 'application/json' }, body: new Blob([JSON.stringify(said)]).stream(), duplex: 'half' } as RequestInit).catch(() => null);
    expect((await unsized({ handle: 'lovelace' }))?.status).toBe(200);
    expect(await profile(ada)).toMatchObject({ handle: 'lovelace' });
    const tooMuch = await unsized({ name: 'x'.repeat(5000) }); // (refused as it comes: the asking may fail rather than read the 413)
    expect(tooMuch === null || tooMuch.status === 413).toBe(true);
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

  describe('following', () => {
    const FOLLOWING = '/profile/following';
    const followingOf = async (browser: Browser): Promise<unknown> => (await browser.ask(FOLLOWING)).json();
    const follow = (browser: Browser, handle: string): Promise<Response> => browser.ask(`${FOLLOWING}/${handle}`, undefined, { method: 'PUT' });
    const unfollow = (browser: Browser, handle: string): Promise<Response> => browser.ask(`${FOLLOWING}/${handle}`, undefined, { method: 'DELETE' });
    const NONE = { rounds: 0, ahead: 0, behind: 0, edge: 0, points: 0, theirs: 0, snipes: 0, sniped: 0 };
    /** Someone followed, as listed: a page anyone signed in can see, with you against them (no rounds here), or one that is theirs alone. */
    const seen = (name: string, handle: string) => ({ name, handle, picture: null, versus: NONE });
    const hidden = (name: string) => ({ name, handle: null, picture: null, versus: null });
    const CY: Googler = { sub: 'google-789', email: 'cy@example.com', name: 'Cyrus Young' };

    it('is by their handle (in any case), and undone again, one way: the one followed is asked nothing', async () => {
      fakeGoogle([ADA, BOB, CY]);
      const ada = await signedIn(ADA);
      const bob = await signedIn(BOB);
      await signedIn(CY);
      expect(await followingOf(ada)).toEqual([]);
      const followed = await follow(ada, 'Bob');
      expect(followed.status).toBe(200);
      expect(await followed.json()).toEqual([seen('Bob', 'bob')]);
      expect((await follow(ada, 'bob')).status).toBe(200); // (twice is once)
      expect(await (await follow(ada, 'cyrus')).json()).toEqual([
        seen('Bob', 'bob'),
        seen('Cyrus', 'cyrus'),
      ]);
      expect(await followingOf(bob)).toEqual([]);
      expect(await (await unfollow(ada, 'bob')).json()).toEqual([seen('Cyrus', 'cyrus')]);
      expect(await (await unfollow(ada, 'bob')).json()).toEqual([seen('Cyrus', 'cyrus')]); // (and unfollowing twice is once)
      expect(rows('follow')).toHaveLength(1);
    });

    it('lists one whose page is private by name alone, and nobody to follow', async () => {
      fakeGoogle([ADA, BOB, CY]);
      const ada = await signedIn(ADA);
      const bob = await signedIn(BOB);
      const cy = await signedIn(CY);
      await follow(ada, 'bob');
      await bob.ask('/profile', { private: true }, { method: 'PUT' });
      await cy.ask('/profile', { private: true }, { method: 'PUT' });
      const listed = await ada.ask(FOLLOWING);
      expect(await listed.clone().json()).toEqual([hidden('Bob')]);
      expect(await listed.text()).not.toContain('"bob"'); // (where a private page is, it never says)
      expect((await follow(ada, 'cyrus')).status).toBe(404); // (as for a handle that is nobody's)
      expect((await unfollow(ada, 'cyrus')).status).toBe(200); // (and unfollowing is answered alike)
      expect(await followingOf(ada)).toEqual([hidden('Bob')]);
      await bob.ask('/profile', { private: false }, { method: 'PUT' });
      expect(await followingOf(ada)).toEqual([seen('Bob', 'bob')]);
    });

    it('is nobody\'s for nobody signed in, and not of yourself, of nobody, or from another site', async () => {
      const ada = await signedIn(ADA);
      await signedIn(BOB);
      const guest = new Browser(server.port);
      expect((await guest.ask(FOLLOWING)).status).toBe(401);
      expect((await follow(guest, 'bob')).status).toBe(401);
      expect((await unfollow(guest, 'bob')).status).toBe(401);
      expect((await follow(ada, 'ada')).status).toBe(400);
      expect((await follow(ada, 'nobody-here')).status).toBe(404);
      expect((await follow(ada, 'x')).status).toBe(404); // (no handle at all)
      expect((await ada.ask(`${FOLLOWING}/bob`, undefined, { method: 'PUT', origin: 'https://evil.example' })).status).toBe(403);
      expect((await ada.ask(`${FOLLOWING}/bob`, undefined, { method: 'DELETE', origin: 'https://evil.example' })).status).toBe(403);
      expect((await ada.ask(FOLLOWING, undefined, { method: 'PUT' })).status).toBe(405);
      expect((await ada.ask(`${FOLLOWING}/bob`)).status).toBe(405);
      expect(await followingOf(ada)).toEqual([]);
      expect(rows('follow')).toEqual([]);
    });

    it('says you against each one, over every round you both played', async () => {
      const ada = await signedIn(ADA);
      await signedIn(BOB);
      const [a, b] = rows('user').map((u) => u.id as string);
      for (const [round, adas, bobs] of [
        [1, 12, 5],
        [2, 3, 9],
        [3, 7, 4],
      ] as const) {
        write('insert into round (id, created_at, game, code, number, ending, ms) values (?, 0, \'g\', \'ABCD\', ?, \'nertz\', 1000)', round, round);
        write('insert into hand (round, seat, player, name, account, played, nertz_left, delta, nertz) values (?, 0, 0, \'Ada\', ?, 0, 0, ?, 0)', round, a!, adas);
        write('insert into hand (round, seat, player, name, account, played, nertz_left, delta, nertz) values (?, 1, 1, \'Bob\', ?, 0, 0, ?, 0)', round, b!, bobs);
      }
      expect(await (await follow(ada, 'bob')).json()).toEqual([{ ...seen('Bob', 'bob'), versus: { rounds: 3, ahead: 2, behind: 1, edge: 1 / 3, points: 22, theirs: 18, snipes: 0, sniped: 0 } }]);
    });

    it('goes with either account', async () => {
      const ada = await signedIn(ADA);
      const bob = await signedIn(BOB);
      await follow(ada, 'bob');
      await follow(bob, 'ada');
      expect(rows('follow')).toHaveLength(2);
      expect((await bob.ask('/profile', undefined, { method: 'DELETE' })).status).toBe(204);
      expect(rows('follow')).toEqual([]);
      expect(await followingOf(ada)).toEqual([]);
    });
  });

  it('is made for anyone who signed up before there were profiles', async () => {
    await signedIn(ADA);
    await server.close();
    write('delete from profile');
    await start();
    expect(rows('profile')).toMatchObject([{ name: 'Ada', handle: 'ada', handle_chosen: 0 }]);
  });

  it('is given a page of its own if it was made before there were pages: from its name, the first to sign up first', async () => {
    fakeGoogle([ADA, BOB, { sub: 'google-789', email: 'ada2@example.com', name: 'Ada Byron' }, { sub: 'google-0', email: 'x@example.com', name: '李' }]);
    for (const sub of ['google-123', 'google-456', 'google-789', 'google-0']) await new Browser(server.port).signIn({ sub } as Googler);
    await server.close();
    // (The database as it was before the migration that makes them: and one with no name, from signing in by email.)
    write("update profile set name = null where name = '李'");
    write("update \"user\" set createdAt = '2026-01-0' || (case email when 'ada@example.com' then 1 when 'bob@example.com' then 2 when 'ada2@example.com' then 3 else 4 end) || 'T00:00:00.000Z'");
    write('drop table room');
    write('drop table follow');
    write('alter table profile drop column handle_chosen');
    write('alter table profile drop column private');
    write('drop index profile_handle');
    write('alter table profile drop column handle');
    write('pragma user_version = 5');
    await start();
    const email = new Map(rows('user').map((u) => [u.id, u.email]));
    const handles = Object.fromEntries(rows('profile').map((p) => [email.get(p.account), p.handle]));
    expect(handles).toEqual({ 'ada@example.com': 'ada', 'bob@example.com': 'bob', 'ada2@example.com': 'ada-2', 'x@example.com': expect.stringMatching(DRAWN) });
    expect(((await profile(await signedIn(ADA))) as { handle: string }).handle).toBe('ada');
  });

  it('is anyone\'s page, not private, if it was made before pages could be', async () => {
    const ada = await signedIn(ADA);
    await ada.ask('/profile', { private: true }, { method: 'PUT' });
    await server.close();
    // (The database as it was before the migration that adds the switch.)
    write('drop table room');
    write('drop table follow');
    write('alter table profile drop column handle_chosen');
    write('alter table profile drop column private');
    write('pragma user_version = 6');
    await start();
    expect(rows('profile')).toMatchObject([{ name: 'Ada', private: 0 }]);
    expect(await profile(await signedIn(ADA))).toMatchObject({ private: false });
    expect(() => write('update profile set private = 2')).toThrow(); // (a yes or a no, and nothing else)
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
