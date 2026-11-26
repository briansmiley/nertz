// Rounds played offline, on their way to the record of whoever played them (`POST /stats`, server/stats.ts). A window
// playing offline asks nothing of the server, so it cannot know who is signed in: it goes by who was last (`heard`,
// remembered by this browser until the server says nobody is). Its rounds are kept for that account, in localStorage
// (client/local.ts keeps them, if the settings say Save stats), and sent once the server says that account is signed in
// again: as it says so, when the network comes back, and a minute after a try the server put off. Kept for any other
// account, they wait for that one.
//
// As for feedback (client/outbox.ts): what is kept is every window's of this browser, each round has an id, a window
// sends them one at a time under a lock the windows share (`navigator.locks`), and takes out exactly the one it sent; the
// server keeps a round sent twice once. So a round goes once.
import type { RoundRecord } from '../server/rounds';

/** A round as it is kept: an id of its own, whose it is, and when it was played. */
export interface Waiting {
  id: string;
  account: string;
  at: number;
  round: RoundRecord;
}

const KEY = 'nertz.rounds';
/** Who was signed in, the last the server said. */
const ACCOUNT_KEY = 'nertz.account';
/** No more than this many are kept: the oldest go first. */
const MOST = 500;
const PATIENCE_MS = 60_000;
/** How long after the server put a round off what is kept is tried again. */
const AGAIN_MS = 60_000;

const newId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

function kept(): Waiting[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? (v as Waiting[]) : [];
  } catch {
    return [];
  }
}

function write(rounds: Waiting[]): void {
  try {
    if (rounds.length) localStorage.setItem(KEY, JSON.stringify(rounds));
    else localStorage.removeItem(KEY);
  } catch {
    // no storage, or no room in it: the round is on nobody's record
  }
}

/** Takes the round `id` out of what is kept: that one, wherever it is by now, and no other. */
const settle = (id: string): void => write(kept().filter((r) => r.id !== id));

function remembered(): string | null {
  try {
    return localStorage.getItem(ACCOUNT_KEY);
  } catch {
    return null;
  }
}

/** Who the server says is signed in, as it was last asked: their id; null for nobody, or not known. Only theirs are sent. */
let signedAs: string | null = null;

/**
 * What the server said of who is signed in (client/account.ts): an account (remembered, and what is kept for it is
 * sent); nobody (then nobody is remembered either: a sign-in that is over counts for nothing offline); or `undefined`,
 * not known (offline, or not answered yet: whoever was remembered still is, and nothing is sent).
 */
export function heard(account: string | null | undefined): void {
  signedAs = account ?? null;
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, account);
    else if (account === null) localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // no storage: nothing is kept for anyone
  }
  if (account) void flush();
}

/** A round played offline, kept for whoever was last signed in here: for nobody, if nobody was. */
export function keep(round: RoundRecord, at = Date.now()): void {
  const account = remembered();
  if (account) write([...kept().slice(-(MOST - 1)), { id: newId(), account, at, round }]);
}

/**
 * What the server made of a round: taken (or had it already); refused for good (a 4xx); not for whoever is signed in
 * there now (401 for nobody, 409 for someone else: it waits for its own account); or not now, and whether it is worth
 * trying again in a while (not so with no network to send on, which says when it is back).
 */
type Answer = 'taken' | 'refused' | 'theirs' | { again: boolean };
async function send(round: Waiting): Promise<Answer> {
  const waiting = new AbortController();
  const late = setTimeout(() => waiting.abort(), PATIENCE_MS);
  try {
    const res = await fetch('/stats', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(round), signal: waiting.signal });
    if (res.ok) return 'taken';
    if (res.status === 401 || res.status === 409) return 'theirs';
    return res.status >= 400 && res.status < 500 && res.status !== 429 ? 'refused' : { again: true };
  } catch {
    return { again: waiting.signal.aborted };
  } finally {
    clearTimeout(late);
  }
}

let retry: ReturnType<typeof setTimeout> | undefined;
/** What is kept is tried again in a while: once, however often that is asked. */
function again(): void {
  clearTimeout(retry);
  retry = setTimeout(() => void flush(), AGAIN_MS);
}

/** Runs `fn` while no other window of this browser is running one: under the lock they share, where the browser has such a thing. */
const alone = (fn: () => Promise<void>): Promise<void> => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request(KEY, fn) : fn());

let flushing = false;
/** What is kept for whoever is signed in is sent, the oldest first, until one does not get there (it and the rest wait for next time). One the server refuses for good is dropped. */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    await alone(async () => {
      // (Read anew each time: another window may have sent some while this one waited its turn.)
      const next = (): Waiting | undefined => (signedAs ? kept().find((r) => r.account === signedAs) : undefined);
      for (let round = next(); round; round = next()) {
        const answer = await send(round);
        if (answer === 'theirs') return;
        if (typeof answer === 'object') return void (answer.again && again());
        settle(round.id);
      }
    });
  } finally {
    flushing = false;
  }
}

/** From now on what is kept is sent whenever it may be: as soon as the server says who is signed in (`heard`), when the network is back, and a while after the server put it off. */
export function startRecord(): void {
  window.addEventListener('online', () => void flush());
}
