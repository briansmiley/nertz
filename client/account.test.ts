import { describe, expect, it } from 'vitest';
import { read } from './account';

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
