// Feedback on its way to the server (`/feedback`, server/feedback.ts). It is sent, whatever the settings say of playing
// offline; and where it cannot be sent just now (no network, no answer in time, a server that cannot, too many at once)
// it is kept by this browser, in localStorage, and sent later: when the page loads, when the network comes back, and a
// minute after a try the server put off.
//
// What is kept is every window's of this browser, and goes once (client/queue.ts).
import { newId, queue, send as sent } from './queue';

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
/** How long whoever is waiting at the slip is kept waiting for an answer; and what was kept, sent with nobody waiting. */
const PATIENCE_MS = 5_000;
const KEPT_PATIENCE_MS = 60_000;
/** How long after the server put a report off (`Answer.again`) what is kept is tried again. */
const AGAIN_MS = 60_000;

/**
 * What the server made of a report: taken; refused for good (a 4xx: it will never take it as it is); or not now, with
 * what it said, if it said anything. `again`: it is worth trying in a while (it answered that it cannot just now or
 * has had too many, or did not answer within `patience`); not so with no network to send on, which says when it is back.
 */
type Answer = { k: 'taken' } | { k: 'refused'; message?: string } | { k: 'later'; message?: string; again: boolean };
const send = ({ id: _, ...report }: Kept, patience: number): Promise<Answer> =>
  sent<Answer>(
    '/feedback',
    report,
    patience,
    async (res) => {
      const body = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (res.ok && body?.ok) return { k: 'taken' };
      const message = typeof body?.message === 'string' ? body.message : undefined;
      return res.status >= 400 && res.status < 500 && res.status !== 429 ? { k: 'refused', message } : { k: 'later', message, again: true };
    },
    (worth) => ({ k: 'later', again: worth }),
  );

/**
 * What was kept is sent, the oldest first, until one does not get there (it and the rest wait for next time). One the
 * server refuses for good is tried once more without its screenshot (too big a picture must not cost the words), and
 * then dropped.
 */
const { kept, write, settle, again, flush } = queue<Kept>(KEY, AGAIN_MS, (all) => all[0], async (next) => {
  const answer = await send(next, KEPT_PATIENCE_MS);
  if (answer.k === 'later') {
    if (answer.again) again();
    return false;
  }
  if (answer.k === 'refused' && next.image) settle(next.id, { ...next, image: null });
  else settle(next.id);
  return true;
});
export { flush };

/** Sends `report`; or, if it cannot be sent just now, keeps it for later (without its screenshot, if the browser has no room for that). */
export async function post(report: Report): Promise<Posted> {
  const mine: Kept = { ...report, id: newId() };
  const answer = await send(mine, PATIENCE_MS);
  if (answer.k === 'taken') return { k: 'sent' };
  if (answer.k === 'later') {
    const before = kept().slice(-(MOST - 1));
    if (answer.again) again();
    if (write([...before, mine]) || write([...before, { ...mine, image: null }])) return { k: 'kept' };
  }
  return { k: 'error', message: answer.message ?? FAILED };
}

/** From now on what is kept is sent whenever it may be: now, when the network is back, and a while after the server put it off (`again`). */
export function startOutbox(): void {
  window.addEventListener('online', () => void flush());
  void flush();
}
