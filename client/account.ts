// Who is signed in on this browser, and who they are at the table, as the server says (server/profile.ts). Signing in
// is with Google or with a code sent to one's email; the server keeps the session in a cookie, so this file holds
// nothing of its own: it asks. The same for their record (`/stats`), someone's page (`/stats/<handle>`), who they follow
// (`/profile/following`), and for an admin how much the game is played (`/usage`).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { addressIn, goBack, moved } from './address';
import { reach, subscribe as onNet } from './net';
import { heard, owesSignOut, signedOut } from './record';
import { handleOf } from '../shared/protocol';
import type { Account, Among, Followed, Page, Stats, Usage, Versus, Way } from '../shared/types';

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
  heard(signedIn(next)?.id ?? (waysIn(next) ? null : undefined)); // (rounds played offline go to whoever this is: client/record.ts)
  for (const l of listeners) l();
};

/**
 * Who sits down, at the top of the pad. Signed in (with a name): you, your picture and name, which open your page.
 * Signed out where the server keeps accounts: a guest, in that same place, with Sign in beside it and the name they
 * play under written below. Where there are no accounts (or signed in with no name yet), only a name to write. While
 * the server has not said which: a guest if this browser has sat down as one `before`, else nothing yet.
 */
export type Sitter = 'you' | 'guest' | 'name' | 'wait';
export const sitter = (signed: Signed, before: boolean): Sitter => {
  const you = signedIn(signed);
  if (you) return you.name ? 'you' : 'name';
  if (signed === 'unknown') return before ? 'guest' : 'wait';
  return waysIn(signed) ? 'guest' : 'name';
};

/** What an answer from `/profile` comes to: a 401 is nobody signed in, with the ways in; and anything but a profile (the 404 for no accounts kept, a proxy with no server behind it) is no signing in. */
export function read(status: number, body: unknown): Signed {
  if (status === 401) {
    const said = (body as { ways?: unknown } | null)?.ways;
    const ways = (Array.isArray(said) ? said : []).filter((w): w is Way => w === 'google' || w === 'email');
    return ways.length ? { ways } : 'off';
  }
  const v = body as { id?: unknown; name?: unknown; image?: unknown; picture?: unknown; handle?: unknown; private?: unknown; admin?: unknown } | null;
  if (status !== 200 || !v || typeof v.id !== 'string' || typeof v.handle !== 'string') return 'off';
  return { id: v.id, name: typeof v.name === 'string' && v.name ? v.name : null, image: typeof v.image === 'string' ? v.image : null, picture: ownPicture(v.picture), handle: v.handle, private: v.private === true, ...(v.admin === true && { admin: true as const }) };
}

const PROFILE = '/profile';

/** A picture's address, if it is one of ours (server/pictures.ts): nothing else is shown as anyone's picture. */
export const ownPicture = (v: unknown): string | null => (typeof v === 'string' && /^\/pictures\/[0-9a-f]{16}\.webp$/.test(v) ? v : null);

async function ask(): Promise<void> {
  if (!reach().server) return set('off'); // no server to ask: nobody is signed in, and there is no signing in
  if (owesSignOut() && (await post('/sign-out', {}).catch(() => null))) signedOut(); // (signed out here while offline: client/record.ts)
  try {
    const res = await fetch(PROFILE, { credentials: 'same-origin', cache: 'no-store' });
    const said = read(res.status, await res.json().catch(() => null));
    if (reach().server) set(said);
  } catch {
    if (reach().server) set('off'); // no answer at all: nothing to offer
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

// Offline, or back from it: who is signed in is asked again (and until the server has said, is not known).
let server = reach().server;
onNet(() => {
  if (server === reach().server) return;
  server = reach().server;
  if (!asked) return;
  if (server) set('unknown');
  void ask();
});

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

/** Off your own page, if it is up: signed out, it is nobody's you can see. */
function leaveYourPage(): void {
  const you = signedIn(signed);
  if (you && addressIn(location.pathname)?.handle === you.handle) goBack();
}

export async function signOut(): Promise<void> {
  await post('/sign-out', {}).catch(() => null);
  leaveYourPage();
  await ask();
}

/** Some of your profile changed: whether it was taken (and the address following your page, if that moved); else, the server's no (0 for none). */
async function change(fields: { name?: string; handle?: string; private?: boolean }): Promise<true | number> {
  const res = await fetch(PROFILE, { method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(fields) }).catch(() => null);
  if (!res?.ok) return res?.status ?? 0;
  const was = signedIn(signed)?.handle;
  const next = read(res.status, await res.json().catch(() => null));
  if (typeof next !== 'object') return 0;
  set(next);
  const now = signedIn(next)?.handle;
  if (was && now && now !== was) moved(was, now);
  return true;
}

/** A new name to go by (cleaned by the server): whether it was taken. */
export const rename = async (name: string): Promise<boolean> => (await change({ name })) === true;

/** What came of claiming a handle: yours now; someone else's, or the site's; or not, for no answer, or any other no. */
export type Claimed = 'yours' | 'taken' | 'failed';

/** What the server's answer to a claim comes to (`change`'s: taken, or its no, 0 for none). */
export const claimedBy = (answer: true | number): Claimed => (answer === true ? 'yours' : answer === 409 ? 'taken' : 'failed');

/** Your page moved to `handle` (in any case: the server keeps it in lower). */
export const rehandle = async (handle: string): Promise<Claimed> => claimedBy(await change({ handle }));

/** Your page made yours alone, or anyone's signed in again: whether it was taken. */
export const setPrivate = async (on: boolean): Promise<boolean> => (await change({ private: on })) === true;

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
  if (res?.ok) leaveYourPage();
  await ask();
  return !!res?.ok;
}

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

/** What an answer to "what is my record?" comes to: null for none to show (nobody signed in, nothing kept, no good answer). */
export function readStats(status: number, body: unknown): Stats | null {
  const v = body as Partial<Record<keyof Stats, unknown>> | null;
  const most = (n: unknown): n is number | null => n === null || whole(n);
  const share = (n: unknown): n is number | null => n === null || (typeof n === 'number' && n >= 0 && n <= 1);
  if (status !== 200 || !v) return null;
  const { rounds, won, nertz, points, bestPoints, cards, bestCards, nertzLeft, ahead, snipes, sniped } = v;
  if (!whole(rounds) || !whole(won) || !whole(nertz) || !whole(points) || !most(bestPoints) || !whole(cards) || !most(bestCards) || !whole(nertzLeft) || !share(ahead) || !whole(snipes) || !whole(sniped)) return null;
  return { rounds, won, nertz, points, bestPoints, cards, bestCards, nertzLeft, ahead, snipes, sniped };
}

/** How you have done against someone, as the server says it: null for an answer that is not that. */
function readVersus(body: unknown): Versus | null {
  const v = body as Partial<Record<keyof Versus, unknown>> | null;
  if (!v) return null;
  const { rounds, ahead, behind, edge, points, theirs, snipes, sniped } = v;
  const signedShare = (n: unknown): n is number => typeof n === 'number' && n >= -1 && n <= 1;
  if (!whole(rounds) || !whole(ahead) || !whole(behind) || !signedShare(edge) || !whole(points) || !whole(theirs) || !whole(snipes) || !whole(sniped)) return null;
  return { rounds, ahead, behind, edge, points, theirs, snipes, sniped };
}

/**
 * What an answer to "whose page is this?" comes to: theirs; `nobody` for nobody signed in to see it (401); `none` for
 * no such page, or no good answer.
 */
export function readPage(status: number, body: unknown): Page | 'nobody' | 'none' {
  if (status === 401) return 'nobody';
  const v = body as { name?: unknown; picture?: unknown; stats?: unknown; versus?: unknown } | null;
  if (status !== 200 || !v) return 'none';
  const stats = readStats(200, v.stats);
  const versus = v.versus === null ? null : readVersus(v.versus);
  if (!stats || (v.versus !== null && !versus) || (v.name !== null && typeof v.name !== 'string')) return 'none';
  return { name: typeof v.name === 'string' && v.name ? v.name : null, picture: ownPicture(v.picture), stats, versus };
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

/**
 * The page of whoever `handle` is, over the rounds `among` says, as whoever is signed in here sees it: asked for afresh
 * as either changes, or someone else signs in (what was last heard staying up meanwhile). Undefined until it is known.
 */
export function usePage(handle: string, among: Among): Page | 'nobody' | 'none' | undefined {
  const who = signedIn(useAccount())?.id ?? null;
  const [page, setPage] = useState<{ of: string; page: Page | 'nobody' | 'none' }>();
  useEffect(() => {
    let stale = false;
    fetch(`/stats/${handle}?among=${among}`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => readPage(res.status, await res.json().catch(() => null)))
      .catch(() => 'none' as const)
      .then((page) => stale || setPage({ of: handle, page }));
    return () => void (stale = true);
  }, [handle, among, who]);
  return page?.of === handle ? page.page : undefined;
}

/**
 * What an answer about who you follow comes to: null for none to show (nobody signed in, no good answer). Where a page
 * is theirs alone, nothing but their name is heard.
 */
export function readFollowing(status: number, body: unknown): Followed[] | null {
  if (status !== 200 || !Array.isArray(body)) return null;
  const read = (f: unknown): Followed | null => {
    const v = f as { name?: unknown; handle?: unknown; picture?: unknown; versus?: unknown } | null;
    if (!v || (v.name !== null && typeof v.name !== 'string')) return null;
    const name = v.name || null;
    if (v.handle === null) return { name, handle: null, picture: null, versus: null };
    if (typeof v.handle !== 'string' || handleOf(v.handle) !== v.handle) return null;
    const versus = v.versus === null ? null : readVersus(v.versus);
    return v.versus !== null && !versus ? null : { name, handle: v.handle, picture: ownPicture(v.picture), versus };
  };
  const list = body.map(read);
  return list.every((f) => f !== null) ? list : null;
}

const FOLLOWING = `${PROFILE}/following`;
/** Who you follow as last heard, and who you are. */
let following: { of: string; list: Followed[] } | null = null;
const followingListeners = new Set<() => void>();
const subscribeFollowing = (l: () => void): (() => void) => (followingListeners.add(l), () => void followingListeners.delete(l));
/** How often who you follow has been asked about: only the last answer is heard (a follow answered after a later unfollow must not undo it). */
let followingAsks = 0;
/** Whose following is being asked for just now: everything that shows it, come up together, asks once. */
let askingFollowing: string | null = null;

/** Asks who `who` follows, or (`handle`, `on`) follows or unfollows someone: whether the server took it. */
async function askFollowing(who: string, change?: { handle: string; on: boolean }): Promise<boolean> {
  const n = ++followingAsks;
  const res = await fetch(change ? `${FOLLOWING}/${change.handle}` : FOLLOWING, { method: change ? (change.on ? 'PUT' : 'DELETE') : 'GET', credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
  const list = res && readFollowing(res.status, await res.json().catch(() => null));
  if (!list) return false;
  if (n === followingAsks && signedIn(signed)?.id === who) {
    following = { of: who, list };
    for (const l of followingListeners) l();
  }
  return true;
}

/** Whoever's page `handle` is, followed or unfollowed: whether it was taken. */
export async function follow(handle: string, on: boolean): Promise<boolean> {
  const who = signedIn(signed)?.id;
  return !!who && (await askFollowing(who, { handle, on }));
}

/**
 * Who whoever is signed in follows, asked for afresh each time something that shows it comes up (what was last heard
 * staying up meanwhile): null until it is known, and if there is none to know.
 */
export function useFollowing(): Followed[] | null {
  const who = signedIn(useAccount())?.id ?? null;
  const known = useSyncExternalStore(subscribeFollowing, () => following);
  useEffect(() => {
    if (!who || askingFollowing === who) return;
    askingFollowing = who;
    void askFollowing(who).finally(() => {
      if (askingFollowing === who) askingFollowing = null;
    });
  }, [who]);
  return known?.of === who ? known.list : null;
}

/**
 * How much the game is played, for an admin (`GET /usage`), its days as dates here, over the rounds `among` says:
 * asked for each time something that shows it comes up, or changes which. Undefined until it is known; null for no
 * good answer.
 */
export function useUsage(among: Among): Usage | null | undefined {
  const [usage, setUsage] = useState<Usage | null>();
  useEffect(() => {
    let stale = false;
    fetch(`/usage?tz=${new Date().getTimezoneOffset()}&among=${among}`, { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as Usage) : null))
      .catch(() => null)
      .then((u) => stale || setUsage(u && Array.isArray(u.days) && Array.isArray(u.games) && u.total ? u : null));
    return () => void (stale = true);
  }, [among]);
  return usage;
}
