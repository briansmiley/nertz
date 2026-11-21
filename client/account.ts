// Who is signed in on this browser, and who they are at the table, as the server says (server/profile.ts). Signing in
// is with Google; the server keeps the session in a cookie, so this file holds nothing of its own: it asks. The same
// for their record (`/stats`).
import { useEffect, useSyncExternalStore } from 'react';
import type { Account, Among, Stats } from '../shared/types';

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

/** What an answer from `/profile` comes to: a 401 is nobody signed in, and anything but a profile (the 404 for no accounts kept, a proxy with no server behind it) is no signing in. */
export function read(status: number, body: unknown): Signed {
  if (status === 401) return 'out';
  const v = body as { id?: unknown; name?: unknown; image?: unknown } | null;
  if (status !== 200 || !v || typeof v.id !== 'string') return 'off';
  return { id: v.id, name: typeof v.name === 'string' && v.name ? v.name : null, image: typeof v.image === 'string' ? v.image : null };
}

const PROFILE = '/profile';

async function ask(): Promise<void> {
  try {
    const res = await fetch(PROFILE, { credentials: 'same-origin', cache: 'no-store' });
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

/** A new name to go by (cleaned by the server): whether it was taken. */
export async function rename(name: string): Promise<boolean> {
  const res = await fetch(PROFILE, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => null);
  if (!res?.ok) return false;
  const next = read(res.status, await res.json().catch(() => null));
  if (typeof next === 'object') set(next);
  return typeof next === 'object';
}

/** The account gone for good, and with it the signing in: whether it went. */
export async function deleteAccount(): Promise<boolean> {
  const res = await fetch(PROFILE, { method: 'DELETE', credentials: 'same-origin' }).catch(() => null);
  await ask();
  return !!res?.ok;
}

/** What an answer to "what is my record?" comes to: null for none to show (nobody signed in, nothing kept, no good answer). */
export function readStats(status: number, body: unknown): Stats | null {
  const v = body as Partial<Record<keyof Stats, unknown>> | null;
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
  const place = (n: unknown): n is number | null => n === null || (typeof n === 'number' && n >= 1);
  if (status !== 200 || !v || !whole(v.rounds) || !whole(v.won) || !whole(v.nertz) || !whole(v.points) || !place(v.place) || !(v.best === null || whole(v.best)) || !whole(v.snipes) || !whole(v.sniped)) return null;
  return { rounds: v.rounds, won: v.won, nertz: v.nertz, points: v.points, place: v.place, best: v.best, snipes: v.snipes, sniped: v.sniped };
}

/** The record last heard, and whose it is: shown at once when it is wanted again, while it is asked for afresh. */
let record: { of: string; stats: Stats | null } | null = null;
const recordListeners = new Set<() => void>();
const subscribeRecord = (l: () => void): (() => void) => (recordListeners.add(l), () => void recordListeners.delete(l));

/**
 * The record of whoever is signed in, over the rounds `among` says, asked for afresh each time something that shows it
 * comes up or asks for other rounds (the figures last heard staying up meanwhile): null until it is known, and if there is none.
 */
export function useStats(among: Among = 'all'): Stats | null {
  const account = useAccount();
  const who = typeof account === 'object' ? account.id : null;
  const known = useSyncExternalStore(subscribeRecord, () => record);
  useEffect(() => {
    if (!who) return;
    let stale = false;
    fetch(`/stats?among=${among}`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => readStats(res.status, await res.json().catch(() => null)))
      .catch(() => null)
      .then((stats) => {
        if (stale) return;
        record = { of: who, stats };
        for (const l of recordListeners) l();
      });
    return () => void (stale = true);
  }, [who, among]);
  return known?.of === who ? known.stats : null;
}
