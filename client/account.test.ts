import { describe, expect, it } from 'vitest';
import { read, readStats, signedIn, waysIn } from './account';

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
    const ada = { id: 'u1', name: 'Ada', image: null };
    expect(signedIn(ada)).toBe(ada);
    expect(waysIn(ada)).toBeNull();
    expect(signedIn({ ways: ['email'] })).toBeNull();
    expect(waysIn({ ways: ['email'] })).toEqual(['email']);
    expect(signedIn('off')).toBeNull();
    expect(waysIn('unknown')).toBeNull();
  });

  it('is whoever the profile is', () => {
    expect(read(200, { id: 'u1', name: 'Ada', image: 'https://example.com/a.png', extra: 'x' })).toEqual({ id: 'u1', name: 'Ada', image: 'https://example.com/a.png' });
    expect(read(200, { id: 'u1', name: 'Ada' })).toEqual({ id: 'u1', name: 'Ada', image: null });
    expect(read(200, { id: 'u1', name: null, image: null })).toEqual({ id: 'u1', name: null, image: null });
  });
});

describe('the record the server says is theirs', () => {
  const record = { rounds: 42, won: 17, nertz: 9, points: 261, place: 1.8, best: 23, snipes: 31, sniped: 12 };

  it('is what it says, and nothing else it may have sent along', () => {
    expect(readStats(200, { ...record, extra: 'x' })).toEqual(record);
    expect(readStats(200, { rounds: 0, won: 0, nertz: 0, points: 0, place: null, best: null, snipes: 0, sniped: 0 })).toEqual({ rounds: 0, won: 0, nertz: 0, points: 0, place: null, best: null, snipes: 0, sniped: 0 });
  });

  it('is none for nobody signed in, nothing kept, or an answer that is not a record', () => {
    expect(readStats(401, null)).toBeNull();
    expect(readStats(404, null)).toBeNull();
    expect(readStats(200, null)).toBeNull();
    expect(readStats(200, { ...record, points: '261' })).toBeNull();
    expect(readStats(200, { ...record, best: undefined })).toBeNull();
    expect(readStats(200, { ...record, place: 0 })).toBeNull();
  });
});
