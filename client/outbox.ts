// Feedback on its way to the server (`/feedback`, server/feedback.ts). Online it is sent, and the server's answer is
// the answer. Offline (client/net.ts `NetState.offline`) it is kept by this browser, in localStorage, and sent once the
// window is online again: when the page loads, when Offline is turned off, when the network comes back.
import { current, subscribe } from './net';

export interface Report {
  kind: 'bug' | 'idea';
  text: string;
  name?: string;
  room?: string;
  context: string;
  image: string | null;
}

/** What came of a report: sent; kept to send later; or not taken, and why. */
export type Posted = { k: 'sent' } | { k: 'kept' } | { k: 'error'; message: string };

const KEY = 'nertz.outbox';
/** No more than this many are kept: the oldest go first. */
const MOST = 20;
const FAILED = 'That did not go through. Try again in a moment.';

function kept(): Report[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? (v as Report[]) : [];
  } catch {
    return [];
  }
}

/** Writes what is kept; false if the browser would not take it (no storage, or no room in it). */
function write(reports: Report[]): boolean {
  try {
    if (reports.length) localStorage.setItem(KEY, JSON.stringify(reports));
    else localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}

/** What the server made of `report`: taken, refused (it will never take it; with what it said), or not reached. */
async function send(report: Report): Promise<'taken' | 'unreached' | { refused: string }> {
  try {
    const res = await fetch('/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report) });
    const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (res.ok && body?.ok) return 'taken';
    return res.status >= 400 && res.status < 500 && res.status !== 429 ? { refused: body?.message ?? FAILED } : 'unreached';
  } catch {
    return 'unreached';
  }
}

/** Sends `report`, or offline keeps it for later (without its screenshot, if the browser has no room for that). */
export async function post(report: Report): Promise<Posted> {
  if (current().offline) {
    const before = kept().slice(-(MOST - 1));
    return write([...before, report]) || write([...before, { ...report, image: null }]) ? { k: 'kept' } : { k: 'error', message: 'That could not be kept. Try again online.' };
  }
  const answer = await send(report);
  return answer === 'taken' ? { k: 'sent' } : { k: 'error', message: answer === 'unreached' ? FAILED : answer.refused };
}

let flushing = false;
/** Online: what was kept is sent, the oldest first, until one does not get there (it and the rest wait for next time). One the server refuses is dropped. */
export async function flush(): Promise<void> {
  if (flushing || current().offline) return;
  flushing = true;
  try {
    for (let next = kept()[0]; next && !current().offline; next = kept()[0]) {
      if ((await send(next)) === 'unreached') return;
      write(kept().slice(1));
    }
  } finally {
    flushing = false;
  }
}

/** From now on what is kept is sent whenever it may be: now, when Offline is turned off, and when the network is back. */
export function startOutbox(): void {
  let offline = current().offline;
  subscribe(() => {
    if (offline === current().offline) return;
    offline = current().offline;
    void flush();
  });
  window.addEventListener('online', () => void flush());
  void flush();
}
