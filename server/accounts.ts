// Accounts: who someone is beyond one table. Signing in is with Google, and nothing else; nobody has to.
//
// The game runs without any of this. Accounts are on when there is a database to keep them in (server/db.ts) and the
// environment names a Google OAuth client (see .env.example); otherwise /api/auth answers 404 and the client shows no
// way to sign in.
//
// Better Auth does the work: the OAuth exchange, the session cookie, and its own tables (user, session, account,
// verification) in the database, which it brings up to date on boot. This file is the only one that knows it.
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Account } from '../shared/types';
import type { Db } from './db';

/** Every route of Better Auth's is under this path. Google is told to come back to `${url}${AUTH_PATH}/callback/google`. */
export const AUTH_PATH = '/api/auth';

export interface Accounts {
  /** Answers a request under `AUTH_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Who a request's cookie says is signed in: null for nobody. Never rejects: asking gone wrong is said in the log, and is nobody. */
  who(headers: IncomingHttpHeaders): Promise<Account | null>;
}

export interface AccountsOptions {
  /** Where the app is reached from outside, with no trailing slash: `https://nertz.binarysmile.com`. */
  url: string;
  /** Signs the session cookies. */
  secret: string;
  google: { id: string; secret: string };
}

/**
 * What the environment asks for: the options, or the names of what it would still take. (With all three of the Google
 * client and the secret missing, nobody meant to set accounts up; with only some of it there, somebody did.)
 */
export function accountsFromEnv(env: NodeJS.ProcessEnv = process.env): AccountsOptions | { missing: string[] } {
  const dev = env.NODE_ENV !== 'production';
  const url = env.PUBLIC_URL ?? (dev ? `http://localhost:${Number(env.VITE_PORT) || 5173}` : undefined);
  const { AUTH_SECRET: secret, GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: googleSecret } = env;
  if (!url || !secret || !id || !googleSecret) {
    return { missing: [!id && 'GOOGLE_CLIENT_ID', !googleSecret && 'GOOGLE_CLIENT_SECRET', !secret && 'AUTH_SECRET', !url && 'PUBLIC_URL'].filter((name) => typeof name === 'string') };
  }
  return { url: url.replace(/\/+$/, ''), secret, google: { id, secret: googleSecret } };
}

/** Google's keys to someone's account, which signing in hands over and nothing here needs. */
const NO_KEYS = { accessToken: null, refreshToken: null, idToken: null };

export async function openAccounts(db: Db, options: AccountsOptions): Promise<Accounts> {
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
    // Name and picture are Google's, taken afresh at each signing in: nobody sets their own.
    socialProviders: { google: { clientId: options.google.id, clientSecret: options.google.secret, overrideUserInfoOnSignIn: true } },
    disabledPaths: ['/update-user', '/change-email', '/delete-user', '/link-social', '/unlink-account', '/list-accounts'],
    // Kept: who someone is (name, email, picture). Not kept: where they signed in from and on what, nor Google's own
    // keys to their account, which nothing here has a use for. (public/privacy.html says as much.)
    databaseHooks: {
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
  const auth = betterAuth(config);
  const handler = toNodeHandler(auth);
  return {
    handle: handler,
    who: async (headers) => {
      // (Asking gone wrong is nobody signed in; said in the log, since a hand played meanwhile is then nobody's.)
      const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch((err: unknown) => (console.error('accounts: asking who is signed in', err), null));
      return session ? { id: session.user.id, name: session.user.name, image: session.user.image ?? null } : null;
    },
  };
}
