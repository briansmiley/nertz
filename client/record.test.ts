// Rounds played offline on their way to a record (client/record.ts): kept for whoever was last signed in, sent once the
// server says they are signed in again, and each sent once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundRecord } from '../server/rounds';
import type { Waiting } from './record';

let storage: Map<string, string>;
/** What the server was sent, and what it answers each with (the last of them, again and again): a status, or no network to send on. */
let sent: Waiting[];
let answers: (number | 'down')[];
let online: (() => void) | undefined;

/** A window of the browser: the page's script of its own. */
async function load(): Promise<typeof import('./record')> {
  vi.resetModules();
  return import('./record');
}
/** A round, told apart by its number. */
const round = (number: number): RoundRecord => ({ game: 'g', code: 'ABCD', number, end: { by: 'jam' }, ms: 1000, hands: [], snipes: [] });
const keptNow = (): Waiting[] => JSON.parse(storage.get('nertz.rounds') ?? '[]') as Waiting[];
/** The rounds kept, as whose and which. */
const kept = (): [string, number][] => keptNow().map((r) => [r.account, r.round.number]);
/** Someone signed in, as the server says. */
const who = (id: string) => ({ id, name: id, image: null, picture: null });
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
  storage = new Map();
  sent = [];
  answers = [200];
  online = undefined;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => type === 'online' && (online = fn) });
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    await new Promise((r) => setTimeout(r, 1)); // (the network takes a moment: long enough for another window to be at it too)
    if (answer === 'down') throw new TypeError('Failed to fetch');
    sent.push(JSON.parse(init.body) as Waiting);
    return { ok: answer === 200, status: answer };
  });
  let held: Promise<unknown> = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_name: string, fn: () => Promise<void>) => (held = held.then(fn, fn)) } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('rounds played offline', () => {
  it('are kept for whoever was last signed in, until the server says nobody is; with nobody, none are kept', async () => {
    const record = await load();
    record.keep(round(1));
    expect(kept()).toEqual([]);
    answers = ['down'];
    record.heard(who('ada'));
    record.heard(undefined); // (offline: who it was is not known, and is still remembered)
    record.keep(round(2), 5);
    expect(keptNow()).toEqual([{ id: expect.stringMatching(/^[0-9a-f]{24}$/), account: 'ada', at: 5, round: round(2) }]);
    record.heard(null); // (back, and the sign-in is over)
    record.keep(round(3));
    expect(kept()).toEqual([['ada', 2]]);
  });

  it('remember who was signed in, name and picture, across a reload: who you are offline', async () => {
    let record = await load();
    answers = ['down'];
    record.heard({ id: 'ada', name: 'Ada', image: null, picture: '/pictures/0123456789abcdef.webp' });
    record = await load();
    record.heard(undefined);
    expect(record.remembered()).toEqual({ id: 'ada', name: 'Ada', image: null, picture: '/pictures/0123456789abcdef.webp' });
    expect(record.remembered()).toBe(record.remembered()); // (the same, read twice: React's to compare)
  });

  it('signed out offline, none more are kept and those kept wait for their account; the server is owed the sign-out, even after a reload, until it takes it', async () => {
    let record = await load();
    record.heard(who('ada'));
    record.heard(undefined);
    record.keep(round(1));
    expect(record.owesSignOut()).toBe(false);
    record.forget();
    expect(record.remembered()).toBeNull();
    record.keep(round(2));
    expect(kept()).toEqual([['ada', 1]]);
    record = await load();
    expect(record.owesSignOut()).toBe(true);
    record.signedOut();
    expect(record.owesSignOut()).toBe(false);
    expect(kept()).toEqual([['ada', 1]]);
  });

  it('go once the server says their account is signed in, the oldest first, and are taken out; others wait for theirs', async () => {
    const record = await load();
    record.heard(who('ada'));
    await settled();
    record.heard(undefined);
    record.keep(round(1));
    record.heard(who('bob'));
    record.heard(undefined);
    record.keep(round(2));
    record.heard(who('ada'));
    record.heard(undefined);
    record.keep(round(3));
    expect(kept()).toEqual([['ada', 1], ['bob', 2], ['ada', 3]]);
    record.heard(who('ada'));
    await settled();
    expect(sent.map((r) => r.round.number)).toEqual([1, 3]);
    expect(kept()).toEqual([['bob', 2]]);
    // Not known (offline), nothing goes; then bob's goes when it is bob.
    record.heard(undefined);
    void record.flush();
    await settled();
    expect(sent).toHaveLength(2);
    record.heard(who('bob'));
    await settled();
    expect(sent.map((r) => [r.account, r.round.number])).toEqual([['ada', 1], ['ada', 3], ['bob', 2]]);
    expect(storage.has('nertz.rounds')).toBe(false);
  });

  it('one the server refuses for good is dropped; signed in as someone else there (or nobody), it waits; with no network it goes when that is back', async () => {
    const record = await load();
    record.heard(who('ada'));
    record.heard(undefined);
    for (const n of [1, 2, 3]) record.keep(round(n));
    answers = [400, 409];
    record.heard(who('ada'));
    await settled();
    expect(kept()).toEqual([['ada', 2], ['ada', 3]]);
    answers = [401];
    void record.flush();
    await settled();
    expect(kept()).toEqual([['ada', 2], ['ada', 3]]);
    answers = ['down'];
    void record.flush();
    await settled();
    expect(kept()).toHaveLength(2);
    answers = [200];
    record.startRecord();
    online!();
    await settled();
    expect(storage.has('nertz.rounds')).toBe(false);
  });

  it('what the server put off is tried again a minute later', async () => {
    vi.useFakeTimers();
    const record = await load();
    record.heard(who('ada'));
    record.heard(undefined);
    record.keep(round(1));
    answers = [503];
    record.heard(who('ada'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(1);
    answers = [200];
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(2);
    expect(storage.has('nertz.rounds')).toBe(false);
  });

  it('with several windows open, each round goes once', async () => {
    storage.set('nertz.rounds', JSON.stringify([1, 2, 3, 4].map((n) => ({ id: `r${n}`, account: 'ada', at: 0, round: round(n) }))));
    const windows = [await load(), await load(), await load()];
    for (const w of windows) w.heard(who('ada'));
    await settled();
    expect(sent.map((r) => r.round.number)).toEqual([1, 2, 3, 4]);
    expect(storage.has('nertz.rounds')).toBe(false);
  });
});
