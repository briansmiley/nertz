// Rounds played offline, on their way to the record of whoever played them (`POST /stats`, server/stats.ts). A window
// playing offline asks nothing of the server, so it cannot know who is signed in: it goes by who was last (`heard`,
// remembered by this browser until the server says nobody is). Its rounds are kept for that account, in localStorage
// (client/local.ts keeps them, if the settings say Save stats), and sent once the server says that account is signed in
// again: as it says so, when the network comes back, and a minute after a try the server put off. Kept for any other
// account, they wait for that one.
//
// As for feedback (client/outbox.ts), what is kept is every window's of this browser, and goes once (client/queue.ts);
// the server keeps a round sent twice once besides.
import type { RoundRecord } from '../server/rounds';
import type { Account } from '../shared/types';
import { useSyncExternalStore } from 'react';
import { newId, queue, send as sent } from './queue';

/** A round as it is kept: an id of its own, whose it is, and when it was played. */
export interface Waiting {
  id: string;
  account: string;
  at: number;
  round: RoundRecord;
}

const KEY = 'nertz.rounds';
/** Who was signed in, the last the server said: who you still are offline. */
const ACCOUNT_KEY = 'nertz.account';
/** Signed out here while offline: the server still has them signed in, until it is told. */
const OWED_KEY = 'nertz.signOut';
/** No more than this many are kept: the oldest go first. */
const MOST = 500;
const PATIENCE_MS = 60_000;
/** How long after the server put a round off what is kept is tried again. */
const AGAIN_MS = 60_000;

/** Who was signed in here last, as the server said: their id, and what is shown of them offline. */
export type Remembered = Pick<Account, 'id' | 'name' | 'image' | 'picture'>;

/** What was last read of who is remembered, as it was kept: read again only when what is kept changes. */
let read: { kept: string | null; who: Remembered | null } = { kept: null, who: null };

/** Who was signed in here last, as the server said: what is played offline is kept for them; null for nobody. */
export function remembered(): Remembered | null {
  let kept: string | null = null;
  try {
    kept = localStorage.getItem(ACCOUNT_KEY);
  } catch {
    // no storage: nobody is remembered
  }
  if (kept !== read.kept) read = { kept, who: rememberedFrom(kept) };
  return read.who;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
function rememberedFrom(kept: string | null): Remembered | null {
  try {
    const v = kept && (JSON.parse(kept) as Partial<Record<keyof Remembered, unknown>> | null);
    const id = v && text(v.id);
    return id ? { id, name: text(v.name), image: text(v.image), picture: text(v.picture) } : null;
  } catch {
    return null;
  }
}

const rememberers = new Set<() => void>();
/** Who is remembered here, as it changes. */
export const useRemembered = (): Remembered | null =>
  useSyncExternalStore((l) => (rememberers.add(l), () => void rememberers.delete(l)), remembered);

/** Signed out offline: nobody is remembered, and the server is owed a sign-out. */
export function forget(): void {
  try {
    localStorage.setItem(OWED_KEY, '1');
  } catch {
    // no storage: nobody was remembered
  }
  heard(null);
}

/** Whether the server is owed a sign-out (`forget`). */
export function owesSignOut(): boolean {
  try {
    return localStorage.getItem(OWED_KEY) !== null;
  } catch {
    return false;
  }
}

/** The server took the sign-out it was owed. */
export function signedOut(): void {
  try {
    localStorage.removeItem(OWED_KEY);
  } catch {
    // no storage: none was owed
  }
}

/** Who the server says is signed in, as it was last asked: their id; null for nobody, or not known. Only theirs are sent. */
let signedAs: string | null = null;

/**
 * What the server said of who is signed in (client/account.ts): an account (remembered, and what is kept for it is
 * sent); nobody (then nobody is remembered either: a sign-in that is over counts for nothing offline); or `undefined`,
 * not known (offline, or not answered yet: whoever was remembered still is, and nothing is sent).
 */
export function heard(account: Remembered | null | undefined): void {
  signedAs = account?.id ?? null;
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify({ id: account.id, name: account.name, image: account.image, picture: account.picture }));
    else if (account === null) localStorage.removeItem(ACCOUNT_KEY);
  } catch {
    // no storage: nothing is kept for anyone
  }
  for (const l of rememberers) l();
  if (account) void flush();
}

/** A round played offline, kept for whoever was last signed in here: for nobody, if nobody was. */
export function keep(round: RoundRecord, at = Date.now()): void {
  const account = remembered()?.id;
  if (account) write([...kept().slice(-(MOST - 1)), { id: newId(), account, at, round }]);
}

/**
 * What the server made of a round: taken (or had it already); refused for good (a 4xx); not for whoever is signed in
 * there now (401 for nobody, 409 for someone else: it waits for its own account); or not now, and whether it is worth
 * trying again in a while (not so with no network to send on, which says when it is back).
 */
type Answer = 'taken' | 'refused' | 'theirs' | { again: boolean };
const send = (round: Waiting): Promise<Answer> =>
  sent<Answer>(
    '/stats',
    round,
    PATIENCE_MS,
    async (res) => {
      if (res.ok) return 'taken';
      if (res.status === 401 || res.status === 409) return 'theirs';
      return res.status >= 400 && res.status < 500 && res.status !== 429 ? 'refused' : { again: true };
    },
    (worth) => ({ again: worth }),
  );

/** What is kept for whoever is signed in is sent, the oldest first, until one does not get there (it and the rest wait for next time). One the server refuses for good is dropped. */
const { kept, write, settle, again, flush } = queue<Waiting>(KEY, AGAIN_MS, (all) => (signedAs ? all.find((r) => r.account === signedAs) : undefined), async (round) => {
  const answer = await send(round);
  if (answer === 'theirs') return false;
  if (typeof answer === 'object') {
    if (answer.again) again();
    return false;
  }
  settle(round.id);
  return true;
});
export { flush };

/** From now on what is kept is sent whenever it may be: as soon as the server says who is signed in (`heard`), when the network is back, and a while after the server put it off. */
export function startRecord(): void {
  window.addEventListener('online', () => void flush());
}
