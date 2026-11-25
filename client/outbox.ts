// Feedback on its way to the server (`/feedback`, server/feedback.ts). Online it is sent, and the server's answer is
// the answer. Offline (client/net.ts `NetState.offline`) it is kept by this browser, in localStorage, and sent once the
// window is online again: when the page loads, when Offline is turned off, when the network comes back.
//
// What is kept is every window's of this browser: each report has an id, a window sends them one at a time under a lock
// the windows share (`navigator.locks`), and takes out exactly the one it sent. So a report goes once, however many
// windows are open when the network comes back.
import { reach, subscribe } from './net';

export interface Report {
  kind: 'bug' | 'idea';
  text: string;
  name?: string;
  room?: string;
  context: string;
  image: string | null;
}
/** A report as it is kept: with an id of its own, which is how it is taken out again. */
type Kept = Report & { id: string };

/** What came of a report: sent; kept to send later; or not taken, and why. */
export type Posted = { k: 'sent' } | { k: 'kept' } | { k: 'error'; message: string };

const KEY = 'nertz.outbox';
/** No more than this many are kept: the oldest go first. */
const MOST = 20;
const FAILED = 'That did not go through. Try again in a moment.';

const newId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

function kept(): Kept[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    // (One kept before reports had ids is given one by what it says: the same in every window.)
    return Array.isArray(v) ? (v as Partial<Kept>[]).map((r) => ({ ...(r as Report), id: typeof r.id === 'string' ? r.id : `old:${r.context ?? ''}:${r.text ?? ''}` })) : [];
  } catch {
    return [];
  }
}

/** Writes what is kept; false if the browser would not take it (no storage, or no room in it). */
function write(reports: Kept[]): boolean {
  try {
    if (reports.length) localStorage.setItem(KEY, JSON.stringify(reports));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** Takes the report `id` out of what is kept, or puts `as` in its place: that one, wherever it is by now, and no other. */
const settle = (id: string, as?: Kept): boolean => write(kept().flatMap((r) => (r.id !== id ? [r] : as ? [as] : [])));

/**
 * What the server made of a report: taken; refused for good (a 4xx: it will never take it as it is); or not now (no
 * answer, too many at once, or a server that cannot just now). With what it said, if it said anything.
 */
type Answer = { k: 'taken' } | { k: 'refused' | 'later'; status: number; message?: string };
async function send({ id: _, ...report }: Kept): Promise<Answer> {
  try {
    const res = await fetch('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (res.ok && body?.ok) return { k: 'taken' };
    const message = typeof body?.message === 'string' ? body.message : undefined;
    return { k: res.status >= 400 && res.status < 500 && res.status !== 429 ? 'refused' : 'later', status: res.status, message };
  } catch {
    return { k: 'later', status: 0 };
  }
}

/** Sends `report`; or, with no server to send it to, keeps it for later (without its screenshot, if the browser has no room for that). */
export async function post(report: Report): Promise<Posted> {
  const mine: Kept = { ...report, id: newId() };
  if (!reach().server) {
    const before = kept().slice(-(MOST - 1));
    return write([...before, mine]) || write([...before, { ...mine, image: null }]) ? { k: 'kept' } : { k: 'error', message: 'That could not be kept. Try again online.' };
  }
  const answer = await send(mine);
  return answer.k === 'taken' ? { k: 'sent' } : { k: 'error', message: answer.message ?? FAILED };
}

/** Runs `fn` while no other window of this browser is running one: under the lock they share, where the browser has such a thing. */
const alone = (fn: () => Promise<void>): Promise<void> => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(KEY, fn) : fn());

let flushing = false;
/**
 * With a server to send to: what was kept is sent, the oldest first, until one does not get there (it and the rest wait
 * for next time). One the server refuses for good is tried once more without its screenshot (too big a picture must not
 * cost the words), and then dropped.
 */
export async function flush(): Promise<void> {
  if (flushing || !reach().server) return;
  flushing = true;
  try {
    await alone(async () => {
      // (What is kept is read anew each time: another window may have sent some of it while this one waited its turn.)
      for (let next = kept()[0]; next && reach().server; next = kept()[0]) {
        const answer = await send(next);
        if (answer.k === 'later') return;
        if (answer.k === 'refused' && next.image) settle(next.id, { ...next, image: null });
        else settle(next.id);
      }
    });
  } finally {
    flushing = false;
  }
}

/** From now on what is kept is sent whenever it may be: now, when the server can be reached again (Offline turned off), and when the network is back. */
export function startOutbox(): void {
  let server = reach().server;
  subscribe(() => {
    if (server === reach().server) return;
    server = reach().server;
    void flush();
  });
  window.addEventListener('online', () => void flush());
  void flush();
}
