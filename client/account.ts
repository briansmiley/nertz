// Who is signed in on this browser, as the server says (server/accounts.ts). Signing in is with Google; the server
// keeps the session in a cookie, so this file holds nothing of its own: it asks.
import { useSyncExternalStore } from 'react';

/** Someone signed in. */
export interface Account {
  id: string;
  name: string;
  image: string | null;
}

/**
 * `unknown` until the server has answered; `off` when it keeps no accounts (nobody can sign in, and nothing about
 * signing in is shown); `out` for nobody signed in; else who is.
 */
export type Signed = 'unknown' | 'off' | 'out' | Account;

const AUTH = '/api/auth';
let signed: Signed = 'unknown';
const listeners = new Set<() => void>();
const set = (next: Signed): void => {
  signed = next;
  for (const l of listeners) l();
};

/** What an answer to "who is signed in?" comes to. */
export function read(status: number, body: unknown): Signed {
  if (status === 404) return 'off';
  const user = (body as { user?: { id?: unknown; name?: unknown; image?: unknown } } | null)?.user;
  if (status !== 200 || !user || typeof user.id !== 'string') return 'out';
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
export function useAccount(): Signed {
  if (!asked && typeof window !== 'undefined') {
    asked = true;
    void ask();
  }
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => signed,
    () => signed,
  );
}

const post = (path: string, body: object): Promise<Response> => fetch(`${AUTH}${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Off to Google, and back to this very page (an invite link stays one). */
export async function signIn(): Promise<void> {
  try {
    const res = await post('/sign-in/social', { provider: 'google', callbackURL: location.pathname + location.search });
    const { url } = (await res.json()) as { url?: string };
    if (url) location.assign(url);
  } catch {
    // no way through just now: they are still where they were, and can press again
  }
}

export async function signOut(): Promise<void> {
  await post('/sign-out', {}).catch(() => null);
  await ask();
}
