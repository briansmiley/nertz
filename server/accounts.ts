// Accounts: who someone is beyond one table. Signing in is with Google, or with a code sent to one's email (by
// Resend); nobody has to.
//
// Who signed in is Better Auth's `user`, as Google or their email says, and nothing here writes to it. One email is one
// user, whichever way they come in by: Google's word for an address and a code sent to it are both proof of it. Who they are at the table is
// their `profile` (server/db.ts), ours, theirs to change: made with the account, from Google's first name, and gone with it.
// Where their page is, its `handle`, is drawn at random with it, and theirs to change: what anyone else is shown of
// them, never the account's id.
//
// The game runs without any of this. Accounts are on when there is a database to keep them in (server/db.ts) and the
// environment gives a way in: a Google OAuth client, a Resend key, or both (see .env.example); otherwise /api/auth
// answers 404 and the client shows no way to sign in.
//
// Better Auth does the work: the OAuth exchange, the session cookie, and its own tables (user, session, account,
// verification) in the database, which it brings up to date on boot. This file is the only one that knows it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomInt } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { cleanName, isHandle } from '../shared/protocol';
import type { Account, Way } from '../shared/types';
import { transaction, type Db } from './db';
import { pictureUrl } from './pictures';

/** Every route of Better Auth's is under this path. Google is told to come back to `${url}${AUTH_PATH}/callback/google`. */
export const AUTH_PATH = '/api/auth';

export interface Accounts {
  /** The ways in there are, in the order they are offered. */
  ways: Way[];
  /** Answers a request under `AUTH_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * Who a request's cookie says is signed in: null for nobody (and for an account gone, whose cookie may still be good
   * for a few minutes). Never rejects: asking gone wrong is said in the log, and is nobody.
   */
  who(headers: IncomingHttpHeaders): Promise<Account | null>;
  /** Whose page `handle` is, the name they go by, the picture they put up, and whether it is theirs alone: null for nobody's. */
  whose(handle: string): { id: string; name: string | null; picture: string | null; private: boolean } | null;
  /** Gives `account` a name to go by, already clean and not empty. */
  rename(account: string, name: string): void;
  /**
   * Moves `account`'s page to `handle` (one `isHandle`), freeing the one it had: false, and nothing changed, for one
   * that is someone else's or kept for the site's own.
   */
  rehandle(account: string, handle: string): boolean;
  /** Makes `account`'s page its own alone, or anyone's signed in again. */
  setPrivate(account: string, on: boolean): void;
  /** Gives `account` picture `id` (server/pictures.ts), or none: the id of the one it had, null for none. */
  repicture(account: string, id: string | null): string | null;
  /** Signs out whoever the cookie in `headers` is: the Set-Cookie lines that forget them in their browser. */
  signOut(headers: IncomingHttpHeaders): Promise<string[]>;
  /** Everything accounts keep of `account`: its profile, its sessions, its link to Google, and it. (Run it in a transaction, with whatever else of theirs goes too.) */
  forget(account: string): void;
}

export interface AccountsOptions {
  /** Where the app is reached from outside, with no trailing slash: `https://nertz.binarysmile.com`. */
  url: string;
  /** Signs the session cookies. */
  secret: string;
  /** Signing in with Google, if there is a client for it. */
  google: { id: string; secret: string } | null;
  /** Signing in with a code sent to one's email, if there is a Resend key to send it with, and who it is sent from. */
  email: { resend: string; from: string } | null;
}

/**
 * Codes sent to any one address in a day, whoever asks. Each allows three tries, so this caps the guesses at any
 * address, from anywhere, at 3 x CODES_A_DAY a day (the limit by place only slows each place down). Kept in memory:
 * there is one machine (fly.toml), and a restart forgiving a day's count costs little.
 */
export const CODES_A_DAY = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const SEND_PATH = '/email-otp/send-verification-otp';

/** How many codes each address has been sent over the last day: `take` one if it may have another, `give` back one that never went. */
export function codeAllowance(limit = CODES_A_DAY, windowMs = DAY_MS, now: () => number = Date.now) {
  const sent = new Map<string, number[]>();
  return {
    take(address: string): boolean {
      const t = now();
      for (const [a, times] of sent) {
        const live = times.filter((at) => t - at < windowMs);
        if (live.length) sent.set(a, live);
        else sent.delete(a);
      }
      const times = sent.get(address) ?? [];
      if (times.length >= limit) return false;
      sent.set(address, [...times, t]);
      return true;
    },
    give(address: string): void {
      const times = sent.get(address);
      if (times?.length) sent.set(address, times.slice(0, -1));
    },
  };
}

/** Whether the code this request asked for went: Better Auth swallows a failed send and answers 200 regardless. */
const sending = new AsyncLocalStorage<{ failed: boolean }>();

/** Who the codes come from, unless EMAIL_FROM says: an address of a domain Resend has verified. */
export const EMAIL_FROM = 'Nertz <nertz@mail.binarysmile.com>';

/**
 * What the environment asks for: the options, or the names of what it would still take, and whether any of it was
 * asked for at all (with none of it there, nobody meant to set accounts up; with only some, somebody did).
 */
export function accountsFromEnv(env: NodeJS.ProcessEnv = process.env): AccountsOptions | { missing: string[]; asked: boolean } {
  const dev = env.NODE_ENV !== 'production';
  const url = env.PUBLIC_URL ?? (dev ? `http://localhost:${Number(env.VITE_PORT) || 5173}` : undefined);
  const { AUTH_SECRET: secret, GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: googleSecret, RESEND_API_KEY: resend } = env;
  const google = id && googleSecret ? { id, secret: googleSecret } : null;
  const email = resend ? { resend, from: env.EMAIL_FROM || EMAIL_FROM } : null;
  const missing = [
    !!id !== !!googleSecret && (id ? 'GOOGLE_CLIENT_SECRET' : 'GOOGLE_CLIENT_ID'),
    !google && !email && !id && !googleSecret && 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or RESEND_API_KEY',
    !secret && 'AUTH_SECRET',
    !url && 'PUBLIC_URL',
  ].filter((name) => typeof name === 'string');
  if (missing.length || !url || !secret) return { missing, asked: !!(id || googleSecret || resend || secret) };
  return { url: url.replace(/\/+$/, ''), secret, google, email };
}

/** The name a profile starts from: the first of the names Google gives, null for none. */
export const firstName = (name: string): string | null => cleanName(name.trim().split(' ')[0] ?? '') || null;

/** Handles that would read as the site's own: nobody's to claim (and never drawn). */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(
  'about account accounts admin administrator api app auth anonymous bot bots everyone guest help here home login logout me mod moderator new nertz null official pictures privacy profile root settings signin signout signup staff stats status support system terms u undefined user users www you'.split(' '),
);

/** What a handle is drawn from: lowercase letters and digits, but for those easily taken for one another (0 o, 1 l i). */
export const HANDLE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const DRAWN_HANDLE_LENGTH = 6;

/** A handle drawn at random, `k3f9x2`: one in about 900 million, so a clash with one kept is rare, and drawn again. */
export function drawHandle(): string {
  for (;;) {
    let handle = '';
    for (let i = 0; i < DRAWN_HANDLE_LENGTH; i++) handle += HANDLE_ALPHABET[randomInt(HANDLE_ALPHABET.length)];
    if (!RESERVED_HANDLES.has(handle)) return handle;
  }
}

/** Whether `err` is the database refusing a handle someone else has (the unique index on `profile.handle`). */
const taken = (err: unknown): boolean => err instanceof Error && /UNIQUE constraint failed: profile\.handle/.test(err.message);

/** Runs `give` with handles drawn at random until one is nobody's (a few tries: more would mean something else is wrong). */
export function withDrawnHandle(give: (handle: string) => void, draw = drawHandle): void {
  for (let tries = 1; ; tries++) {
    try {
      return give(draw());
    } catch (err) {
      if (!taken(err) || tries >= 8) throw err;
    }
  }
}

/** Google's keys to someone's account, which signing in hands over and nothing here needs. */
const NO_KEYS = { accessToken: null, refreshToken: null, idToken: null };

export async function openAccounts(db: Db, options: AccountsOptions): Promise<Accounts> {
  // A profile, made with its account (its name from Google's, if it came from there) and a handle drawn for it.
  const made = db.prepare('insert into profile (account, name, handle) values (?, ?, ?) on conflict (account) do nothing');
  const make = (account: string, name: string): void => withDrawnHandle((handle) => made.run(account, firstName(name), handle));
  const allowance = codeAllowance();
  const config = {
    appName: 'Nertz',
    baseURL: options.url,
    basePath: AUTH_PATH,
    secret: options.secret,
    database: db,
    telemetry: { enabled: false },
    // (Said outright because Better Auth leaves these checks off by itself when it is run by a test.)
    // Whose request it is, for the limit on how often anyone may try to sign in: Fly's word for it, which a client cannot forge.
    advanced: { disableOriginCheck: false, disableCSRFCheck: false, ipAddress: { ipAddressHeaders: ['fly-client-ip'] } },
    // A code asked for: to an address that has had its day's codes, refused; one that did not go (Resend refused it),
    // said so, as 502, rather than the 200 Better Auth gives, and not counted. Neither depends on whether there is an
    // account at the address.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === SEND_PATH && !allowance.take(addressOf(ctx.body))) throw new APIError('TOO_MANY_REQUESTS', { message: 'Enough codes for this address today', code: 'ADDRESS_LIMIT' });
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SEND_PATH || !sending.getStore()?.failed) return;
        allowance.give(addressOf(ctx.body));
        throw new APIError('BAD_GATEWAY', { message: 'The code could not be sent', code: 'NOT_SENT' });
      }),
    },
    // Name and picture are Google's, taken afresh at each signing in: nobody sets their own.
    socialProviders: options.google ? { google: { clientId: options.google.id, clientSecret: options.google.secret, overrideUserInfoOnSignIn: true } } : {},
    // By email, a code: asked for (three a minute from any one place, as Better Auth has it), sent, and typed back
    // within ten minutes, three tries at most. Kept hashed. Only for signing in: there are no passwords here to reset.
    plugins: options.email ? [emailOTP({ otpLength: 6, expiresIn: 10 * 60, allowedAttempts: 3, storeOTP: 'hashed', sendVerificationOTP: sendCode(options.email) })] : [],
    disabledPaths: [
      '/update-user',
      '/change-email',
      '/delete-user',
      '/link-social',
      '/unlink-account',
      '/list-accounts',
      '/email-otp/check-verification-otp',
      '/email-otp/verify-email',
      '/email-otp/request-password-reset',
      '/forget-password/email-otp',
      '/email-otp/reset-password',
      '/email-otp/request-email-change',
      '/email-otp/change-email',
    ],
    // Kept: who someone is (name, email, picture). Not kept: where they signed in from and on what, nor Google's own
    // keys to their account, which nothing here has a use for. (public/privacy.html says as much.)
    databaseHooks: {
      // An account made any way but Google's has no name or picture from the request that made it (Better Auth would
      // take them from the body of a first sign-in by email): its owner chooses a name on their page.
      user: {
        create: {
          before: async (user, ctx) => (ctx?.path?.startsWith('/callback/') ? undefined : { data: { ...user, name: '', image: null } }),
          after: async (user) => make(user.id, user.name),
        },
      },
      session: { create: { before: async (session) => ({ data: { ...session, ipAddress: null, userAgent: null } }) } },
      account: {
        create: { before: async (account) => ({ data: { ...account, ...NO_KEYS } }) },
        update: { before: async (account) => ({ data: { ...account, ...NO_KEYS } }) },
      },
    },
    // A cookie that is good for five minutes without asking the database: a socket reconnecting does not cost a query.
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  } satisfies Parameters<typeof betterAuth>[0];
  await (await getMigrations(config)).runMigrations();
  // Anyone signed up before there were profiles has one made now, as if just signed up. (Here, not in db.ts: `user` is
  // not there until Better Auth has made it.)
  const unmade = db.prepare('select id, name from "user" where id not in (select account from profile)').all() as { id: string; name: string }[];
  if (unmade.length) transaction(db, () => unmade.forEach((u) => make(u.id, u.name)));
  // And any profile made before there were pages is given its handle now, drawn as a new one's is (server/db.ts says why here).
  const unhandled = db.prepare('select account from profile where handle is null').all() as { account: string }[];
  const handled = db.prepare('update profile set handle = ? where account = ?');
  if (unhandled.length) transaction(db, () => unhandled.forEach(({ account }) => withDrawnHandle((handle) => handled.run(handle, account))));
  const named = db.prepare('select name, picture, handle, private from profile where account = ?');
  const whose = db.prepare('select account as id, name, picture, private from profile where handle = ?');
  const rename = db.prepare('update profile set name = ? where account = ?');
  const rehandle = db.prepare('update profile set handle = ? where account = ?');
  const setPrivate = db.prepare('update profile set private = ? where account = ?');
  const setPicture = db.prepare('update profile set picture = ? where account = ?');
  const forgets = ['delete from profile where account = ?', 'delete from session where userId = ?', 'delete from account where userId = ?', 'delete from "user" where id = ?'].map((sql) => db.prepare(sql));
  const auth = betterAuth(config);
  const handler = toNodeHandler(auth);
  return {
    ways: [...(options.google ? (['google'] as const) : []), ...(options.email ? (['email'] as const) : [])],
    handle: (req, res) => sending.run({ failed: false }, () => handler(req, res)),
    who: async (headers) => {
      // (Asking gone wrong is nobody signed in; said in the log, since a hand played meanwhile is then nobody's.)
      const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch((err: unknown) => (console.error('accounts: asking who is signed in', err), null));
      const profile = session && (named.get(session.user.id) as { name: string | null; picture: string | null; handle: string; private: number } | undefined);
      return profile ? { id: session.user.id, name: profile.name, image: session.user.image ?? null, picture: profile.picture && pictureUrl(profile.picture), handle: profile.handle, private: profile.private === 1 } : null;
    },
    whose: (handle) => {
      const them = whose.get(handle) as { id: string; name: string | null; picture: string | null; private: number } | undefined;
      return them ? { ...them, picture: them.picture && pictureUrl(them.picture), private: them.private === 1 } : null;
    },
    rename: (account, name) => void rename.run(name, account),
    // (The one place a handle is claimed. Whether it is free is the database's to say: its unique index.)
    rehandle: (account, handle) => {
      if (!isHandle(handle) || RESERVED_HANDLES.has(handle)) return false;
      try {
        rehandle.run(handle, account);
        return true;
      } catch (err) {
        if (taken(err)) return false;
        throw err;
      }
    },
    setPrivate: (account, on) => void setPrivate.run(on ? 1 : 0, account),
    // (Read and written with nothing between: the database is this process's alone, and node:sqlite is synchronous.)
    repicture: (account, id) => {
      const had = (named.get(account) as { picture: string | null } | undefined)?.picture ?? null;
      setPicture.run(id, account);
      return had;
    },
    signOut: async (headers) => (await auth.api.signOut({ headers: fromNodeHeaders(headers), returnHeaders: true })).headers.getSetCookie(),
    forget: (account) => forgets.forEach((f) => f.run(account)),
  };
}

/** The address a request for a code names, as Better Auth keys it. */
const addressOf = (body: unknown): string => String((body as { email?: unknown } | null)?.email ?? '').trim().toLowerCase();

/** Sends a code to sign in with, by Resend; throws if it is not taken to be sent. Anything but a code to sign in with is not sent at all. */
function sendCode({ resend, from }: NonNullable<AccountsOptions['email']>) {
  return async ({ email, otp, type }: { email: string; otp: string; type: string }): Promise<void> => {
    if (type !== 'sign-in') return;
    try {
      await post({ email, otp });
    } catch (err) {
      const said = sending.getStore();
      if (said) said.failed = true;
      throw err;
    }
  };
  async function post({ email, otp }: { email: string; otp: string }): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${resend}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from,
        to: [email],
        subject: `${otp} is your Nertz code`,
        text: `${otp}\n\nType it in where you asked for it, within ten minutes. If you didn't ask, nothing happens unless it's used.`,
        html: `<p style="font:700 32px/1.2 sans-serif;letter-spacing:4px;margin:0 0 16px">${otp}</p><p style="font:15px/1.4 sans-serif;color:#55616c;margin:0">Type it in where you asked for it, within ten minutes. If you didn't ask, nothing happens unless it's used.</p>`,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend: ${res.status} ${await res.text().catch(() => '')}`);
  }
}
