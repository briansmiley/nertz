// Who is signed in on this browser, as the server says (server/accounts.ts). Signing in is with Google; the server
// keeps the session in a cookie, so this file holds nothing of its own: it asks.
import { useSyncExternalStore } from 'react';
import type { Account } from '../shared/types';

/**
 * `unknown` until the server has answered; `off` when there is no signing in (it keeps no accounts, or gave no good
 * answer), and nothing about signing in is shown; `out` for nobody signed in; else who is.
 */
export type Signed = 'unknown' | 'off' | 'out' | Account;

const AUTH = '/api/auth';
let signed: Signed = 'unknown';
const listeners = new Set<() => void>();
const set = (next: Signed): void => {
  signed = next;
  for (const l of listeners) l();
};

/**
 * What an answer to "who is signed in?" comes to. A server that keeps accounts answers 200 whoever asks; anything else
 * (its 404 for none kept, a proxy with no server behind it) is no signing in.
 */
export function read(status: number, body: unknown): Signed {
  if (status !== 200) return 'off';
  const user = (body as { user?: { id?: unknown; name?: unknown; image?: unknown } } | null)?.user;
  if (!user || typeof user.id !== 'string') return 'out';
  return { id: user.id, name: typeof user.name === 'string' ? user.name : '', image: typeof user.image === 'string' ? user.image : null };
}

async function ask(): Promise<void> {
  try {
    const res = await fetch(`${AUTH}/get-session`, { credentials: 'same-origin', cache: 'no-store' });
    set(read(res.status, await res.json().catch(() => null)));
  } catch {
    set('off'); // no answer at all: nothing to offer
  }
}

let asked = false;
/** The first to want to know sets the asking off. */
const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  if (!asked) {
    asked = true;
    void ask();
  }
  return () => void listeners.delete(l);
};

export function useAccount(): Signed {
  return useSyncExternalStore(subscribe, () => signed);
}

const post = (path: string, body: object): Promise<Response> => fetch(`${AUTH}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Off to Google, and back to this very page (an invite link stays one) whether they went through with it there or not. */
export async function signIn(): Promise<void> {
  const here = location.pathname + location.search;
  const url = await post('/sign-in/social', { provider: 'google', callbackURL: here, errorCallbackURL: here })
    .then(async (res) => ((await res.json()) as { url?: unknown }).url)
    .catch(() => null);
  if (typeof url === 'string') location.assign(url);
  else await ask(); // no way to Google: see whether there is still any signing in, so the way in is not left there doing nothing
}

export async function signOut(): Promise<void> {
  await post('/sign-out', {}).catch(() => null);
  await ask();
}
