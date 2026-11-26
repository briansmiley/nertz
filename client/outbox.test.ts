// Feedback on its way (client/outbox.ts): sent, kept where it cannot be just now, and what was kept sent once it can be.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Report } from './outbox';

let storage: Map<string, string>;
/** What the server was sent, and what it answers each with (the last of them, again and again): a status; no network to send on; or nothing, for as long as it is waited for. */
let sent: Report[];
let answers: (number | 'down' | 'silent')[];
let online: (() => void) | undefined;
/** Run once, as the next report is on its way to the server. */
let onWay: (() => void) | undefined;

/** A window of the browser: the page's script of its own. */
async function load(): Promise<typeof import('./outbox')> {
  vi.resetModules();
  return import('./outbox');
}
const report = (text: string, image: string | null = null): Report => ({ kind: 'bug', text, context: 'offline · lobby', image });
/** Reports as they are kept: each with an id of its own. */
const keep = (...reports: Report[]): void => void storage.set('nertz.outbox', JSON.stringify(reports.map((r, i) => ({ ...r, id: `r${i}` }))));
/** What is kept, as it was reported (each has an id of its own besides). */
const keptNow = (): Report[] => (JSON.parse(storage.get('nertz.outbox') ?? '[]') as (Report & { id?: string })[]).map(({ id: _, ...r }) => r);
const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

beforeEach(() => {
  storage = new Map();
  sent = [];
  answers = [200];
  online = undefined;
  onWay = undefined;
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > 5000) throw new Error('QuotaExceededError');
      storage.set(k, v);
    },
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => type === 'online' && (online = fn) });
  vi.stubGlobal('fetch', async (_url: string, init: { body: string; signal: AbortSignal }) => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    onWay?.();
    onWay = undefined;
    await new Promise((r) => setTimeout(r, 1)); // (the network takes a moment: long enough for another window to be at it too)
    if (answer === 'down') throw new TypeError('Failed to fetch');
    if (answer === 'silent') await new Promise((_, gaveUp) => init.signal.addEventListener('abort', () => gaveUp(new DOMException('Aborted', 'AbortError'))));
    sent.push(JSON.parse(init.body) as Report);
    return { ok: answer === 200, status: answer, json: async () => (answer === 200 ? { ok: true } : { ok: false, message: `No (${answer}).` }) };
  });
  // The lock the windows of one browser share: one holder at a time, the rest in turn.
  let held: Promise<unknown> = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_name: string, fn: () => Promise<void>) => (held = held.then(fn, fn)) } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('feedback on its way', () => {
  it('is sent, and what the server will never take is said to be so: nothing is kept either way', async () => {
    const outbox = await load();
    expect(await outbox.post(report('one'))).toEqual({ k: 'sent' });
    answers = [400];
    expect(await outbox.post(report('two'))).toEqual({ k: 'error', message: 'No (400).' });
    expect(sent.map((r) => r.text)).toEqual(['one', 'two']);
    expect(storage.has('nertz.outbox')).toBe(false);
  });

  it('is kept, in order, where it cannot be sent just now: no network, a server that cannot, too many at once', async () => {
    vi.useFakeTimers();
    const outbox = await load();
    const post = async (r: Report) => {
      const posted = outbox.post(r);
      await vi.advanceTimersByTimeAsync(10);
      return posted;
    };
    answers = ['down'];
    expect(await post(report('one'))).toEqual({ k: 'kept' });
    answers = [503];
    expect(await post(report('two'))).toEqual({ k: 'kept' });
    answers = [429];
    expect(await post(report('three'))).toEqual({ k: 'kept' });
    expect(keptNow().map((r) => r.text)).toEqual(['one', 'two', 'three']);
    expect(sent.map((r) => r.text)).toEqual(['two', 'three']); // (each was tried)
  });

  it('is kept when the server has not answered in five seconds, and not before', async () => {
    vi.useFakeTimers();
    const outbox = await load();
    answers = ['silent'];
    let posted: unknown;
    void outbox.post(report('one')).then((p) => (posted = p));
    await vi.advanceTimersByTimeAsync(4900);
    expect(posted).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(posted).toEqual({ k: 'kept' });
    expect(keptNow()).toEqual([report('one')]);
  });

  it('a screenshot the browser has no room for is left off, and the words kept', async () => {
    const outbox = await load();
    answers = ['down'];
    expect(await outbox.post(report('big', 'x'.repeat(6000)))).toEqual({ k: 'kept' });
    expect(keptNow()).toEqual([report('big')]);
    expect(await outbox.post(report('y'.repeat(6000)))).toMatchObject({ k: 'error' });
  });

  it('what was kept goes as the page loads, the oldest first; with no network it waits, and goes when that is back', async () => {
    keep(report('one'), report('two'));
    answers = [200, 'down'];
    const outbox = await load();
    outbox.startOutbox();
    await settled();
    expect(sent.map((r) => r.text)).toEqual(['one']);
    expect(keptNow().map((r) => r.text)).toEqual(['two']);
    answers = [200];
    online!();
    await settled();
    expect(sent.map((r) => r.text)).toEqual(['one', 'two']);
    expect(storage.has('nertz.outbox')).toBe(false);
  });

  it('what the server put off is tried again a minute later, by one timer however often it was put off', async () => {
    vi.useFakeTimers();
    keep(report('one'));
    answers = [503];
    const outbox = await load();
    outbox.startOutbox();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(1);
    answers = [429];
    void outbox.post(report('two'));
    await vi.advanceTimersByTimeAsync(10);
    void outbox.flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(sent).toHaveLength(3);
    answers = [200];
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent.map((r) => r.text)).toEqual(['one', 'two', 'one', 'one', 'two']);
    expect(storage.has('nertz.outbox')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('with no network nothing is tried again until it is back', async () => {
    vi.useFakeTimers();
    keep(report('one'));
    answers = ['down'];
    const outbox = await load();
    outbox.startOutbox();
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(0);
    expect(keptNow().map((r) => r.text)).toEqual(['one']);
  });

  it('one the server will never take is dropped, not sent for ever; one it cannot take just now waits', async () => {
    vi.useFakeTimers();
    keep(report('bad'), report('good'), report('later'));
    answers = [400, 200, 503];
    const outbox = await load();
    void outbox.flush();
    await vi.advanceTimersByTimeAsync(10);
    expect(keptNow().map((r) => r.text)).toEqual(['later']);
  });

  it('with several windows open, each report goes once: one window sends at a time, and takes out only what it sent', async () => {
    storage.set('nertz.outbox', JSON.stringify(['one', 'two', 'three', 'four'].map((t, i) => ({ ...report(t), id: `r${i}` }))));
    // Three windows of the one browser, each with the page's script of its own, all back online at once.
    const windows = [await load(), await load(), await load()];
    await Promise.all(windows.map((w) => w.flush()));
    expect(sent.map((r) => r.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(storage.has('nertz.outbox')).toBe(false);
  });

  it('takes out the report it sent and no other: one kept meanwhile by another window, ahead of it or behind, stays', async () => {
    storage.set('nertz.outbox', JSON.stringify([{ ...report('one'), id: 'a' }]));
    answers = [200, 'down'];
    const outbox = await load();
    // While 'one' is on its way, another window changes what is kept: 'one' is no longer the first, and two more are there.
    onWay = () => storage.set('nertz.outbox', JSON.stringify([{ ...report('ahead'), id: 'b' }, { ...report('one'), id: 'a' }, { ...report('behind'), id: 'c' }]));
    await outbox.flush();
    expect(sent.map((r) => r.text)).toEqual(['one']);
    expect(keptNow().map((r) => r.text)).toEqual(['ahead', 'behind']);
  });

  it('one refused with a screenshot (too big a picture) goes once more without it, rather than losing the words', async () => {
    storage.set('nertz.outbox', JSON.stringify([{ ...report('big', 'x'.repeat(100)), id: 'a' }, { ...report('next'), id: 'b' }]));
    answers = [413, 200];
    const outbox = await load();
    await outbox.flush();
    expect(sent).toEqual([report('big', 'x'.repeat(100)), report('big'), report('next')]);
    expect(storage.has('nertz.outbox')).toBe(false);
  });
});
