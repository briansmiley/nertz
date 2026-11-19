import { describe, expect, it } from 'vitest';
import { read, readStats } from './account';

describe('who the server says is signed in', () => {
  it('is no signing in at all where the server keeps no accounts, or there is no good answer', () => {
    expect(read(404, null)).toBe('off');
    expect(read(502, null)).toBe('off'); // the dev proxy, with the server not up yet
    expect(read(500, { user: { id: 'u1', name: 'Ada' } })).toBe('off');
  });

  it('is nobody signed in for an empty answer', () => {
    expect(read(200, null)).toBe('out');
    expect(read(200, {})).toBe('out');
  });

  it('is whoever the session names', () => {
    expect(read(200, { user: { id: 'u1', name: 'Ada Lovelace', image: 'https://example.com/a.png', email: 'ada@example.com' }, session: {} })).toEqual({ id: 'u1', name: 'Ada Lovelace', image: 'https://example.com/a.png' });
    expect(read(200, { user: { id: 'u1', name: 'Ada' } })).toEqual({ id: 'u1', name: 'Ada', image: null });
  });
});

describe('the record the server says is theirs', () => {
  const record = { rounds: 42, won: 17, nertz: 9, points: 261, best: 23, snipes: 31, sniped: 12 };

  it('is what it says, and nothing else it may have sent along', () => {
    expect(readStats(200, { ...record, extra: 'x' })).toEqual(record);
    expect(readStats(200, { rounds: 0, won: 0, nertz: 0, points: 0, best: null, snipes: 0, sniped: 0 })).toEqual({ rounds: 0, won: 0, nertz: 0, points: 0, best: null, snipes: 0, sniped: 0 });
  });

  it('is none for nobody signed in, nothing kept, or an answer that is not a record', () => {
    expect(readStats(401, null)).toBeNull();
    expect(readStats(404, null)).toBeNull();
    expect(readStats(200, null)).toBeNull();
    expect(readStats(200, { ...record, points: '261' })).toBeNull();
    expect(readStats(200, { ...record, best: undefined })).toBeNull();
  });
});
