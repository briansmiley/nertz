// Accounts: who someone is beyond one table. Signing in is with Google, and nothing else; nobody has to.
//
// The game runs without any of this. Accounts are on when the environment names a place to keep them and a Google
// OAuth client (see .env.example); otherwise `openAccounts` gives null, /api/auth answers 404 and the client shows no
// way to sign in.
//
// Better Auth does the work: the OAuth exchange, the session cookie, and its own tables (user, session, account,
// verification) in the SQLite file, which it brings up to date on boot. This file is the only one that knows it.
import { mkdirSync } from 'node:fs';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';

/** Every route of Better Auth's is under this path. Google is told to come back to `${url}${AUTH_PATH}/callback/google`. */
export const AUTH_PATH = '/api/auth';

/** Someone signed in: `id` is who they are, for good. Their name and picture are what Google says, and may change. */
export interface Account {
  id: string;
  name: string;
  image: string | null;
}

export interface Accounts {
  /** Answers a request under `AUTH_PATH`. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Who a request's cookie says is signed in: null for nobody. */
  who(headers: IncomingHttpHeaders): Promise<Account | null>;
  close(): void;
}

export interface AccountsOptions {
  /** The SQLite file: a path, or ':memory:'. */
  file: string;
  /** Where the app is reached from outside, with no trailing slash: `https://nertz.fly.dev`. */
  url: string;
  /** Signs the session cookies. */
  secret: string;
  google: { id: string; secret: string };
}

/** What the environment asks for: null unless all of it is there. */
export function accountsFromEnv(env: NodeJS.ProcessEnv = process.env): AccountsOptions | null {
  const dev = env.NODE_ENV !== 'production';
  const dir = env.DATA_DIR ?? (dev ? 'data' : undefined);
  const url = env.PUBLIC_URL ?? (dev ? `http://localhost:${Number(env.VITE_PORT) || 5173}` : undefined);
  if (!dir || !url || !env.AUTH_SECRET || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  mkdirSync(dir, { recursive: true });
  return { file: join(dir, 'nertz.db'), url: url.replace(/\/+$/, ''), secret: env.AUTH_SECRET, google: { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET } };
}

export async function openAccounts(options: AccountsOptions): Promise<Accounts> {
  const db = new DatabaseSync(options.file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const config = {
    appName: 'Nertz',
    baseURL: options.url,
    basePath: AUTH_PATH,
    secret: options.secret,
    database: db,
    telemetry: { enabled: false },
    // (Said outright because Better Auth leaves these checks off by itself when it is run by a test.)
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    socialProviders: { google: { clientId: options.google.id, clientSecret: options.google.secret } },
    // A cookie that is good for five minutes without asking the database: a socket reconnecting does not cost a query.
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  } satisfies Parameters<typeof betterAuth>[0];
  await (await getMigrations(config)).runMigrations();
  const auth = betterAuth(config);
  const handler = toNodeHandler(auth);
  return {
    handle: handler,
    who: async (headers) => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(headers) }).catch(() => null);
      return session ? { id: session.user.id, name: session.user.name, image: session.user.image ?? null } : null;
    },
    close: () => db.close(),
  };
}
