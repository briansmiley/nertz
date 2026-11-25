// Feedback on its way (client/outbox.ts): sent online, kept offline, and what was kept sent once the window is online again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Report } from './outbox';

let storage: Map<string, string>;
/** What the server was sent, and what it answers each with (the last of them, again and again): a status, or no answer at all. */
let sent: Report[];
let answers: (number | 'down')[];
let online: (() => void) | undefined;
/** Run once, as the next report is on its way to the server. */
let onWay: (() => void) | undefined;

async function load(offline: boolean): Promise<{ outbox: typeof import('./outbox'); prefs: typeof import('./prefs') }> {
  vi.resetModules();
  const prefs = await import('./prefs');
  prefs.setPrefs({ offline });
  return { outbox: await import('./outbox'), prefs };
}
const report = (text: string, image: string | null = null): Report => ({ kind: 'bug', text, context: 'offline · lobby', image });
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
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
    onWay?.();
    onWay = undefined;
    await new Promise((r) => setTimeout(r, 1)); // (the network takes a moment: long enough for another window to be at it too)
    if (answer === 'down') throw new TypeError('Failed to fetch');
    sent.push(JSON.parse(init.body) as Report);
    return { ok: answer === 200, status: answer, json: async () => (answer === 200 ? { ok: true } : { ok: false, message: `No (${answer}).` }) };
  });
  // The lock the windows of one browser share: one holder at a time, the rest in turn.
  let held: Promise<unknown> = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_name: string, fn: () => Promise<void>) => (held = held.then(fn, fn)) } });
});
afterEach(() => vi.unstubAllGlobals());

describe('feedback on its way', () => {
  it('online is sent, and the answer is the server\'s: nothing is kept either way', async () => {
    const { outbox } = await load(false);
    expect(await outbox.post(report('one'))).toEqual({ k: 'sent' });
    answers = [400];
    expect(await outbox.post(report('two'))).toEqual({ k: 'error', message: 'No (400).' });
    answers = [503];
    expect(await outbox.post(report('busy'))).toEqual({ k: 'error', message: 'No (503).' }); // (the server's own word for it, whatever it could not do)
    answers = [429];
    expect(await outbox.post(report('often'))).toEqual({ k: 'error', message: 'No (429).' });
    answers = ['down'];
    expect(await outbox.post(report('three'))).toMatchObject({ k: 'error' });
    expect(sent.map((r) => r.text)).toEqual(['one', 'two', 'busy', 'often']);
    expect(storage.has('nertz.outbox')).toBe(false);
  });

  it('offline is kept, in order, and nothing is asked of the server', async () => {
    const { outbox } = await load(true);
    expect(await outbox.post(report('one'))).toEqual({ k: 'kept' });
    expect(await outbox.post(report('two'))).toEqual({ k: 'kept' });
    await outbox.flush();
    expect(sent).toEqual([]);
    expect(keptNow().map((r) => r.text)).toEqual(['one', 'two']);
  });

  it('a screenshot the browser has no room for is left off, and the words kept', async () => {
    const { outbox } = await load(true);
    expect(await outbox.post(report('big', 'x'.repeat(6000)))).toEqual({ k: 'kept' });
    expect(keptNow()).toEqual([report('big')]);
    expect(await outbox.post(report('y'.repeat(6000)))).toMatchObject({ k: 'error' });
  });

  it('what was kept goes when Offline is turned off, the oldest first, and is kept no longer', async () => {
    const { outbox, prefs } = await load(true);
    await outbox.post(report('one'));
    await outbox.post(report('two'));
    outbox.startOutbox();
    await settled();
    expect(sent).toEqual([]);
    prefs.setPrefs({ offline: false });
    await settled();
    expect(sent.map((r) => r.text)).toEqual(['one', 'two']);
    expect(storage.has('nertz.outbox')).toBe(false);
  });

  it('goes as the page loads online; with no server to reach it waits, and goes when the network is back', async () => {
    storage.set('nertz.outbox', JSON.stringify([report('one'), report('two')]));
    answers = [200, 'down'];
    const { outbox } = await load(false);
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

  it('one the server will never take is dropped, not sent for ever; one it cannot take just now waits', async () => {
    storage.set('nertz.outbox', JSON.stringify([report('bad'), report('good'), report('later')]));
    answers = [400, 200, 503];
    const { outbox } = await load(false);
    await outbox.flush();
    expect(keptNow().map((r) => r.text)).toEqual(['later']);
  });

  it('with several windows open, each report goes once: one window sends at a time, and takes out only what it sent', async () => {
    storage.set('nertz.outbox', JSON.stringify(['one', 'two', 'three', 'four'].map((t, i) => ({ ...report(t), id: `r${i}` }))));
    // Three windows of the one browser, each with the page's script of its own, all back online at once.
    const windows = [await load(false), await load(false), await load(false)];
    await Promise.all(windows.map((w) => w.outbox.flush()));
    expect(sent.map((r) => r.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(storage.has('nertz.outbox')).toBe(false);
  });

  it('takes out the report it sent and no other: one kept meanwhile by another window, ahead of it or behind, stays', async () => {
    storage.set('nertz.outbox', JSON.stringify([{ ...report('one'), id: 'a' }]));
    answers = [200, 'down'];
    const { outbox } = await load(false);
    // While 'one' is on its way, another window (offline still) changes what is kept: 'one' is no longer the first, and two more are there.
    onWay = () => storage.set('nertz.outbox', JSON.stringify([{ ...report('ahead'), id: 'b' }, { ...report('one'), id: 'a' }, { ...report('behind'), id: 'c' }]));
    await outbox.flush();
    expect(sent.map((r) => r.text)).toEqual(['one']);
    expect(keptNow().map((r) => r.text)).toEqual(['ahead', 'behind']);
  });

  it('one refused with a screenshot (too big a picture) goes once more without it, rather than losing the words', async () => {
    storage.set('nertz.outbox', JSON.stringify([{ ...report('big', 'x'.repeat(100)), id: 'a' }, { ...report('next'), id: 'b' }]));
    answers = [413, 200];
    const { outbox } = await load(false);
    await outbox.flush();
    expect(sent).toEqual([report('big', 'x'.repeat(100)), report('big'), report('next')]);
    expect(storage.has('nertz.outbox')).toBe(false);
  });
});
