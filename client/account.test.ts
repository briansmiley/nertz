import { describe, expect, it } from 'vitest';
import { claimedBy, read, readFollowing, readPage, readStats, signedIn, sitter, waysIn } from './account';
import { addressIn } from './address';

describe('who the server says is signed in', () => {
  it('is no signing in at all where the server keeps no accounts, or there is no good answer', () => {
    expect(read(404, null)).toBe('off');
    expect(read(502, null)).toBe('off'); // the dev proxy, with the server not up yet
    expect(read(500, { id: 'u1', name: 'Ada' })).toBe('off');
    expect(read(200, null)).toBe('off');
    expect(read(200, {})).toBe('off');
  });

  it('is nobody signed in for a 401, with the ways in it names', () => {
    expect(read(401, { ways: ['google', 'email'] })).toEqual({ ways: ['google', 'email'] });
    expect(read(401, { ways: ['email', 'carrier pigeon'] })).toEqual({ ways: ['email'] });
    expect(read(401, null)).toBe('off'); // (no way in named: nothing to offer)
  });

  it('tells who is signed in from the ways in', () => {
    const ada = { id: 'u1', name: 'Ada', image: null, picture: null, handle: '0123456789abcdef', private: false };
    expect(signedIn(ada)).toBe(ada);
    expect(waysIn(ada)).toBeNull();
    expect(signedIn({ ways: ['email'] })).toBeNull();
    expect(waysIn({ ways: ['email'] })).toEqual(['email']);
    expect(signedIn('off')).toBeNull();
    expect(waysIn('unknown')).toBeNull();
  });

  it('is whoever the profile is', () => {
    const handle = '0123456789abcdef';
    expect(read(200, { id: 'u1', name: 'Ada', image: 'https://example.com/a.png', handle, private: false, extra: 'x' })).toEqual({ id: 'u1', name: 'Ada', image: 'https://example.com/a.png', picture: null, handle, private: false });
    expect(read(200, { id: 'u1', name: 'Ada', handle, private: true })).toMatchObject({ private: true });
    expect(read(200, { id: 'u1', name: 'Ada', handle, private: 'yes' })).toMatchObject({ private: false }); // (only a yes that is one)
    expect(read(200, { id: 'u1', name: 'Ada', image: null, picture: '/pictures/0123456789abcdef.webp', handle })).toMatchObject({ picture: '/pictures/0123456789abcdef.webp' });
    expect(read(200, { id: 'u1', name: 'Ada', image: null, picture: 'https://evil.example/me.webp', handle })).toMatchObject({ picture: null }); // (only ever one of ours)
    expect(read(200, { id: 'u1', name: 'Ada', handle })).toEqual({ id: 'u1', name: 'Ada', image: null, picture: null, handle, private: false });
    expect(read(200, { id: 'u1', name: null, image: null, handle })).toEqual({ id: 'u1', name: null, image: null, picture: null, handle, private: false });
    expect(read(200, { id: 'u1', name: 'Ada', image: null })).toBe('off'); // (no page: not a profile)
    expect(read(200, { id: 'u1', name: 'Ada', handle, admin: true })).toMatchObject({ admin: true });
    expect(read(200, { id: 'u1', name: 'Ada', handle, admin: 'yes' })).not.toHaveProperty('admin'); // (only a yes that is one)
  });
});

describe('the record the server says is theirs', () => {
  const record = { rounds: 42, won: 17, nertz: 9, points: 261, bestPoints: 23, cards: 1010, bestCards: 38, nertzLeft: 210, ahead: 0.62, snipes: 31, sniped: 12 };
  const none = { rounds: 0, won: 0, nertz: 0, points: 0, bestPoints: null, cards: 0, bestCards: null, nertzLeft: 0, ahead: null, snipes: 0, sniped: 0 };

  it('is what it says, and nothing else it may have sent along', () => {
    expect(readStats(200, { ...record, extra: 'x' })).toEqual(record);
    expect(readStats(200, none)).toEqual(none);
  });

  it('is none for nobody signed in, nothing kept, or an answer that is not a record', () => {
    expect(readStats(401, null)).toBeNull();
    expect(readStats(404, null)).toBeNull();
    expect(readStats(200, null)).toBeNull();
    expect(readStats(200, { ...record, points: '261' })).toBeNull();
    expect(readStats(200, { ...record, bestPoints: undefined })).toBeNull();
    expect(readStats(200, { ...record, cards: 10.5 })).toBeNull();
    expect(readStats(200, { ...record, ahead: 1.2 })).toBeNull();
    expect(readStats(200, { ...record, place: 1.8, ahead: undefined })).toBeNull(); // (the record as it was)
  });
});

describe("someone's page, as the server says it", () => {
  const stats = { rounds: 3, won: 1, nertz: 0, points: 12, bestPoints: 9, cards: 30, bestCards: 14, nertzLeft: 6, ahead: 0.5, snipes: 1, sniped: 2 };
  const versus = { rounds: 2, ahead: 1, behind: 0, points: 10, theirs: 4 };

  it('is their name, their record and yours against them; on your own, nobody to be against', () => {
    const picture = '/pictures/0123456789abcdef.webp';
    expect(readPage(200, { name: 'Bob', picture, stats, versus, extra: 'x' })).toEqual({ name: 'Bob', picture, stats, versus });
    expect(readPage(200, { name: 'Ada', picture: null, stats, versus: null })).toEqual({ name: 'Ada', picture: null, stats, versus: null });
    expect(readPage(200, { name: null, stats, versus })).toEqual({ name: null, picture: null, stats, versus });
    expect(readPage(200, { name: 'Bob', picture: 'https://evil.example/me.webp', stats, versus })).toMatchObject({ picture: null }); // (only ever one of ours)
  });

  it('is nobody to show it to for a 401, and no page for anything else that is not one', () => {
    expect(readPage(401, null)).toBe('nobody');
    expect(readPage(404, null)).toBe('none');
    expect(readPage(200, null)).toBe('none');
    expect(readPage(200, { name: 'Bob', stats: { ...stats, won: '1' }, versus })).toBe('none');
    expect(readPage(200, { name: 'Bob', stats, versus: { ...versus, ahead: 0.5 } })).toBe('none');
    expect(readPage(200, { name: 'Bob', stats })).toBe('none');
    expect(readPage(200, { name: 7, stats, versus })).toBe('none');
  });
});

describe('who you follow, as the server says it', () => {
  const versus = { rounds: 3, ahead: 2, behind: 1, points: 40, theirs: 31 };
  it('are each a name, and where their page is, their picture and you against them, but for a private page: its name alone', () => {
    expect(
      readFollowing(200, [
        { name: 'Bob', handle: 'bob', picture: '/pictures/0123456789abcdef.webp', versus, extra: 'x' },
        { name: 'Cy', handle: null, picture: null, versus: null },
        { name: null, handle: 'k3f9x2', picture: 'https://elsewhere.example/x.png', versus: null },
      ]),
    ).toEqual([
      { name: 'Bob', handle: 'bob', picture: '/pictures/0123456789abcdef.webp', versus },
      { name: 'Cy', handle: null, picture: null, versus: null },
      { name: null, handle: 'k3f9x2', picture: null, versus: null }, // (a picture not ours is no picture)
    ]);
    expect(readFollowing(200, [])).toEqual([]);
  });

  it('are none to show for nobody signed in, or an answer that is not a list of them', () => {
    expect(readFollowing(401, { ways: ['google'] })).toBeNull();
    expect(readFollowing(200, null)).toBeNull();
    expect(readFollowing(200, [{ name: 'Bob', handle: '../stats', picture: null, versus: null }])).toBeNull(); // (only ever a handle)
    expect(readFollowing(200, [{ name: 7, handle: 'bob', picture: null, versus: null }])).toBeNull();
    expect(readFollowing(200, [{ name: 'Bob' }])).toBeNull();
    expect(readFollowing(200, [{ name: 'Bob', handle: 'bob', picture: null, versus: { rounds: 'many' } }])).toBeNull();
  });
});

describe('who sits down, on the first page', () => {
  const ways = { ways: ['google', 'email'] } as const;
  const named = { id: 'u', name: 'Ada', image: null, picture: null, handle: '0123456789abcdef', private: false };
  it('signed in with a name: you; signed in without one: a name to write', () => {
    expect(sitter(named, false)).toBe('you');
    expect(sitter({ ...named, name: null }, false)).toBe('name');
  });
  it('signed out where there are accounts: a guest, whether or not they have sat down before', () => {
    expect(sitter({ ways: [...ways.ways] }, false)).toBe('guest');
    expect(sitter({ ways: [...ways.ways] }, true)).toBe('guest');
  });
  it('no accounts kept: only a name to write; not known yet: a guest from before is one still, anyone else waits', () => {
    expect(sitter('off', false)).toBe('name');
    expect(sitter('off', true)).toBe('name');
    expect(sitter('unknown', true)).toBe('guest');
    expect(sitter('unknown', false)).toBe('wait');
  });
});

describe('whose page the address is', () => {
  const pageIn = (path: string): string | null => addressIn(path)?.handle ?? null;
  it('is the handle in /u/<handle>, in any case, and nobody\'s for anything else', () => {
    expect(pageIn('/u/0123456789abcdef')).toBe('0123456789abcdef');
    expect(pageIn('/u/k3f9x2')).toBe('k3f9x2');
    expect(pageIn('/u/Ada-Lovelace')).toBe('ada-lovelace');
    expect(pageIn('/u/0123456789abcdef/')).toBe('0123456789abcdef');
    expect(pageIn('/')).toBeNull();
    expect(pageIn('/u/')).toBeNull();
    expect(pageIn('/u/0123456789ABCDEF')).toBe('0123456789abcdef');
    expect(pageIn('/u/ab')).toBeNull();
    expect(pageIn('/u/-ada')).toBeNull();
    expect(pageIn('/u/a--b')).toBeNull();
    expect(pageIn('/u/0123456789abcdef/more')).toBeNull();
    expect(pageIn('/x/0123456789abcdef')).toBeNull();
  });

  it('is on it who they follow at /u/<handle>/following, and nothing else after the handle', () => {
    expect(addressIn('/u/Ada/following')).toEqual({ handle: 'ada', following: true });
    expect(addressIn('/u/ada/following/')).toEqual({ handle: 'ada', following: true });
    expect(addressIn('/u/ada')).toEqual({ handle: 'ada', following: false });
    expect(addressIn('/u/ada/followers')).toBeNull();
    expect(addressIn('/u/ab/following')).toBeNull();
  });
});

describe('what came of claiming a handle', () => {
  it('is yours on a yes, taken on a 409, and failed on anything else: no answer, a bad one, the server gone wrong', () => {
    expect(claimedBy(true)).toBe('yours');
    expect(claimedBy(409)).toBe('taken');
    for (const no of [0, 400, 401, 403, 500, 502]) expect(claimedBy(no)).toBe('failed');
  });
});
