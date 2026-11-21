// Who is signed in on this browser, and who they are at the table, as the server says (server/profile.ts). Signing in
// is with Google or with a code sent to one's email; the server keeps the session in a cookie, so this file holds
// nothing of its own: it asks. The same for their record (`/stats`).
import { useEffect, useSyncExternalStore } from 'react';
import type { Account, Among, Stats, Way } from '../shared/types';

/**
 * `unknown` until the server has answered; `off` when there is no signing in (it keeps no accounts, or gave no good
 * answer), and nothing about signing in is shown; nobody signed in, and the ways in there are; else who is.
 */
export type Signed = 'unknown' | 'off' | { ways: Way[] } | Account;

/** Who is signed in, if anyone is. */
export const signedIn = (s: Signed): Account | null => (typeof s === 'object' && 'id' in s ? s : null);
/** The ways in, for nobody signed in; null for someone signed in, or no signing in at all. */
export const waysIn = (s: Signed): Way[] | null => (typeof s === 'object' && 'ways' in s ? s.ways : null);

const AUTH = '/api/auth';
let signed: Signed = 'unknown';
const listeners = new Set<() => void>();
const set = (next: Signed): void => {
  signed = next;
  for (const l of listeners) l();
};

/**
 * Who sits down, at the top of the pad. Signed in (with a name): you, your picture and name, which open your page.
 * Otherwise, where the server keeps accounts and you have not yet chosen: Sign in, or Guest. A guest (or anyone, where
 * there are no accounts) writes a name. Nothing while the server has not said which.
 */
export type Sitter = 'you' | 'choose' | 'name' | 'wait';
export const sitter = (signed: Signed, guest: boolean): Sitter => {
  const you = signedIn(signed);
  if (you) return you.name ? 'you' : 'name';
  if (signed === 'unknown') return guest ? 'name' : 'wait';
  return waysIn(signed) && !guest ? 'choose' : 'name';
};

/** What an answer from `/profile` comes to: a 401 is nobody signed in, with the ways in; and anything but a profile (the 404 for no accounts kept, a proxy with no server behind it) is no signing in. */
export function read(status: number, body: unknown): Signed {
  if (status === 401) {
    const said = (body as { ways?: unknown } | null)?.ways;
    const ways = (Array.isArray(said) ? said : []).filter((w): w is Way => w === 'google' || w === 'email');
    return ways.length ? { ways } : 'off';
  }
  const v = body as { id?: unknown; name?: unknown; image?: unknown; picture?: unknown } | null;
  if (status !== 200 || !v || typeof v.id !== 'string') return 'off';
  return { id: v.id, name: typeof v.name === 'string' && v.name ? v.name : null, image: typeof v.image === 'string' ? v.image : null, picture: ownPicture(v.picture) };
}

const PROFILE = '/profile';

/** A picture's address, if it is one of ours (server/pictures.ts): nothing else is shown as anyone's picture. */
export const ownPicture = (v: unknown): string | null => (typeof v === 'string' && /^\/pictures\/[0-9a-f]{16}\.webp$/.test(v) ? v : null);

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

/** What came of asking for a code: sent; not, for an address that is none; not yet, for asking too often from here; not today, for an address sent its day's codes; not, for the email not going; or no answer. */
export type Asked = 'sent' | 'bad' | 'busy' | 'enough' | 'unsent' | 'failed';

/** A code to sign in with, sent to `email`. */
export async function sendCode(email: string): Promise<Asked> {
  const res = await post('/email-otp/send-verification-otp', { email, type: 'sign-in' }).catch(() => null);
  if (!res) return 'failed';
  if (res.ok) return 'sent';
  if (res.status === 429) return ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code === 'ADDRESS_LIMIT' ? 'enough' : 'busy';
  return res.status === 400 ? 'bad' : res.status === 502 ? 'unsent' : 'failed';
}

/** What came of typing a code in: signed in; the wrong code (or one too old); one tried too often, so a new one is wanted; not yet, for trying too often; or no answer. */
export type Entered = 'in' | 'wrong' | 'spent' | 'busy' | 'failed';

/** Signs in with the code sent to `email`. */
export async function enterCode(email: string, otp: string): Promise<Entered> {
  const res = await post('/sign-in/email-otp', { email, otp }).catch(() => null);
  if (res?.ok) {
    await ask();
    return 'in';
  }
  if (!res) return 'failed';
  const code = ((await res.json().catch(() => null)) as { code?: unknown } | null)?.code;
  return res.status === 429 ? 'busy' : res.status === 403 || code === 'OTP_EXPIRED' ? 'spent' : res.status === 400 ? 'wrong' : 'failed';
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

/** The side of a picture as it is sent: the server draws it afresh at its own size (server/pictures.ts); this only keeps what is sent small. */
const SENT_SIDE = 256;

/** The square of a picture to put up, in the picture's own px (turned upright, as its camera said): from its top left corner, and how wide. */
export type Crop = { x: number; y: number; side: number };

/** A square of a picture (`crop`, else the middle one), shrunk to SENT_SIDE (never grown): as a WebP, or a PNG where the browser will not make a WebP. */
async function square(file: Blob, crop?: Crop): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const middle = Math.min(bitmap.width, bitmap.height);
  const { x, y, side } = crop ?? { x: (bitmap.width - middle) / 2, y: (bitmap.height - middle) / 2, side: middle };
  const out = Math.max(1, Math.round(Math.min(SENT_SIDE, side)));
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = out;
  canvas.getContext('2d')!.drawImage(bitmap, x, y, side, side, 0, 0, out, out);
  bitmap.close();
  return new Promise((done, failed) => canvas.toBlob((b) => (b ? done(b) : failed(new Error('no picture'))), 'image/webp', 0.9));
}

/** A picture of you put up (the square `crop` of it), or yours taken down (for null): whether it went. */
export async function repicture(file: Blob | null, crop?: Crop): Promise<boolean> {
  const body = file && (await square(file, crop).catch(() => null));
  if (file && !body) return false;
  const res = await fetch(`${PROFILE}/picture`, { method: body ? 'PUT' : 'DELETE', credentials: 'same-origin', ...(body ? { headers: { 'content-type': body.type }, body } : {}) }).catch(() => null);
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
  const most = (n: unknown): n is number | null => n === null || whole(n);
  const share = (n: unknown): n is number | null => n === null || (typeof n === 'number' && n >= 0 && n <= 1);
  if (status !== 200 || !v) return null;
  const { rounds, won, nertz, points, bestPoints, cards, bestCards, nertzLeft, ahead, snipes, sniped } = v;
  if (!whole(rounds) || !whole(won) || !whole(nertz) || !whole(points) || !most(bestPoints) || !whole(cards) || !most(bestCards) || !whole(nertzLeft) || !share(ahead) || !whole(snipes) || !whole(sniped)) return null;
  return { rounds, won, nertz, points, bestPoints, cards, bestCards, nertzLeft, ahead, snipes, sniped };
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
  const who = signedIn(useAccount())?.id ?? null;
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
