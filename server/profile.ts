// One's own profile, by one's cookie (server/accounts.ts): GET it, PUT a new name to go by, DELETE the account. With
// the account goes everything kept as theirs; the rounds they played and the reports they sent stay, as nobody's.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cleanName } from '../shared/protocol';
import type { Accounts } from './accounts';
import { transaction, type Db } from './db';
import type { Reports } from './reports';
import type { Rounds } from './rounds';

export const PROFILE_PATH = '/profile';
/** A name, and room to spare. */
const MAX_BODY_BYTES = 1024;

export interface ProfileKeeping {
  db: Db;
  accounts: Accounts;
  rounds: Rounds | null;
  reports: Reports | null;
  /** Where a page of ours is served from: a change is taken only from there (as Better Auth asks of its own). */
  home: string;
  /** Tells every table that an account is gone: anyone at one signed in as it plays on as nobody's. */
  gone: (account: string) => void;
}

export function profileHandler({ db, accounts, rounds, reports, home, gone }: ProfileKeeping) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return void res.writeHead(405, { allow: 'GET, PUT, DELETE' }).end();
    if (method !== 'GET' && req.headers.origin !== home) return json(403, null);
    const said = method === 'PUT' ? await read(req) : null;
    if (said === TOO_BIG) return void res.writeHead(413, { connection: 'close' }).end();
    const me = await accounts.who(req.headers);
    if (!me) return json(401, { ways: accounts.ways }); // (nobody: and the ways in there are)
    if (method === 'GET') return json(200, me);
    if (method === 'PUT') {
      const raw = (said as { name?: unknown } | null)?.name;
      const name = typeof raw === 'string' ? cleanName(raw) : '';
      if (!name) return json(400, null);
      accounts.rename(me.id, name);
      return json(200, { ...me, name });
    }
    // All of it at once, or none; then the tables, and the cookies that forget them in this browser. (With the profile
    // gone their cookie is nobody's already: signing out only tidies it away.)
    transaction(db, () => {
      rounds?.forget(me.id);
      reports?.forget(me.id);
      accounts.forget(me.id);
    });
    gone(me.id);
    const forgotten = await accounts.signOut(req.headers).catch((err: unknown) => (console.error('profile: signing out a deleted account', err), []));
    res.writeHead(204, { 'cache-control': 'no-store', 'set-cookie': forgotten }).end();
  };
}

const TOO_BIG = Symbol('too big');

/** The JSON a request carries: null for none that reads, `TOO_BIG` for more than a profile is (or of no stated size). */
async function read(req: IncomingMessage): Promise<unknown> {
  const stated = Number(req.headers['content-length']);
  if (!(stated <= MAX_BODY_BYTES)) return TOO_BIG;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return TOO_BIG;
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
