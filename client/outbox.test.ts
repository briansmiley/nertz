// Feedback on its way (client/outbox.ts): sent online, kept offline, and what was kept sent once the window is online again.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Report } from './outbox';

let storage: Map<string, string>;
/** What the server was sent, and what it answers each with (the last of them, again and again): a status, or no answer at all. */
let sent: Report[];
let answers: (number | 'down')[];
let online: (() => void) | undefined;

async function load(offline: boolean): Promise<{ outbox: typeof import('./outbox'); prefs: typeof import('./prefs') }> {
  vi.resetModules();
  const prefs = await import('./prefs');
  prefs.setPrefs({ offline });
  return { outbox: await import('./outbox'), prefs };
}
const report = (text: string, image: string | null = null): Report => ({ kind: 'bug', text, context: 'offline · lobby', image });
const keptNow = (): Report[] => JSON.parse(storage.get('nertz.outbox') ?? '[]') as Report[];
const settled = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

beforeEach(() => {
  storage = new Map();
  sent = [];
  answers = [200];
  online = undefined;
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
    if (answer === 'down') throw new TypeError('Failed to fetch');
    sent.push(JSON.parse(init.body) as Report);
    return { ok: answer === 200, status: answer, json: async () => (answer === 200 ? { ok: true } : { ok: false, message: 'No.' }) };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('feedback on its way', () => {
  it('online is sent, and the answer is the server\'s: nothing is kept either way', async () => {
    const { outbox } = await load(false);
    expect(await outbox.post(report('one'))).toEqual({ k: 'sent' });
    answers = [400];
    expect(await outbox.post(report('two'))).toEqual({ k: 'error', message: 'No.' });
    answers = ['down'];
    expect(await outbox.post(report('three'))).toMatchObject({ k: 'error' });
    expect(sent.map((r) => r.text)).toEqual(['one', 'two']);
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
});
