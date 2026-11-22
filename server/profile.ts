// One's own profile, by one's cookie (server/accounts.ts): GET it, PUT a new name to go by, a handle of one's own (where
// one's page is), or whether one's page is private (any of them, together or not), DELETE the account; and at
// PICTURE_PATH, PUT a picture of oneself (the image itself, as the body) or DELETE it. With the account goes everything
// kept as theirs, their picture too; the rounds they played and the reports they sent stay, as nobody's.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cleanName, handleOf } from '../shared/protocol';
import type { Account } from '../shared/types';
import type { Accounts } from './accounts';
import { MAX_SENT_BYTES, type Pictures } from './pictures';
import { transaction, type Db } from './db';
import type { Reports } from './reports';
import type { Rounds } from './rounds';

export const PROFILE_PATH = '/profile';
export const PICTURE_PATH = '/profile/picture';
/** A name, and room to spare. */
const MAX_BODY_BYTES = 1024;

export interface ProfileKeeping {
  db: Db;
  accounts: Accounts;
  rounds: Rounds | null;
  reports: Reports | null;
  /** Where pictures of people are kept. Without it (a database in memory), nobody can put one up. */
  pictures: Pictures | null;
  /** Where a page of ours is served from: a change is taken only from there (as Better Auth asks of its own). */
  home: string;
  /** Tells every table that an account is gone: anyone at one signed in as it plays on as nobody's. */
  gone: (account: string) => void;
  /** Tells every table what an account now is: its page made private or not, its picture put up or taken down. */
  changed: (account: Account) => void;
}

export function profileHandler({ db, accounts, rounds, reports, pictures, home, gone, changed }: ProfileKeeping) {
  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const method = req.method ?? 'GET';
    if (path === PICTURE_PATH) return picture(req, res, json);
    if (method !== 'GET' && method !== 'PUT' && method !== 'DELETE') return void res.writeHead(405, { allow: 'GET, PUT, DELETE' }).end();
    if (method !== 'GET' && req.headers.origin !== home) return json(403, null);
    const said = method === 'PUT' ? await read(req) : null;
    if (said === TOO_BIG) return void res.writeHead(413, { connection: 'close' }).end();
    const me = await accounts.who(req.headers);
    if (!me) return json(401, { ways: accounts.ways }); // (nobody: and the ways in there are)
    if (method === 'GET') return json(200, me);
    if (method === 'PUT') {
      // What is said is changed, and nothing else: a name, cleaned and not empty; a handle, in any case (kept in lower);
      // whether the page is private, yes or no. A handle that is someone else's, or the site's, is 409, and then
      // nothing is changed. The one it had is free from then on, and its old links lead nowhere.
      const { name: raw, handle: asked, private: hidden } = (said ?? {}) as { name?: unknown; handle?: unknown; private?: unknown };
      const name = raw === undefined ? undefined : typeof raw === 'string' ? cleanName(raw) : '';
      const handle = asked === undefined ? undefined : typeof asked === 'string' ? handleOf(asked) : null;
      if (name === '' || handle === null || (hidden !== undefined && typeof hidden !== 'boolean') || (name === undefined && handle === undefined && hidden === undefined)) return json(400, null);
      // (A name taken first can move the page too: to the name's, where the handle was only the one made for it.)
      if (handle !== undefined && !accounts.rehandle(me.id, handle)) return json(409, null);
      const now: Account = { ...me, ...(handle !== undefined && { handle }) };
      if (name !== undefined) Object.assign(now, { name, handle: accounts.rename(me.id, name) });
      if (hidden !== undefined) (accounts.setPrivate(me.id, hidden), (now.private = hidden));
      changed(now);
      return json(200, now);
    }
    // All of it at once, or none; then the tables, and the cookies that forget them in this browser. (With the profile
    // gone their cookie is nobody's already: signing out only tidies it away.)
    const had = transaction(db, () => {
      rounds?.forget(me.id);
      reports?.forget(me.id);
      const had = accounts.repicture(me.id, null);
      accounts.forget(me.id);
      return had;
    });
    pictures?.remove(had); // (after: a file gone with its row kept would be worse than one kept with its row gone)
    gone(me.id);
    const forgotten = await accounts.signOut(req.headers).catch((err: unknown) => (console.error('profile: signing out a deleted account', err), []));
    res.writeHead(204, { 'cache-control': 'no-store', 'set-cookie': forgotten }).end();
  };

  /** PUT a picture of yourself, or DELETE yours: answered with your profile as it now is. */
  async function picture(req: IncomingMessage, res: ServerResponse, json: (status: number, body: unknown) => void): Promise<void> {
    const method = req.method ?? 'GET';
    if (method !== 'PUT' && method !== 'DELETE') return void res.writeHead(405, { allow: 'PUT, DELETE' }).end();
    if (req.headers.origin !== home) return json(403, null);
    if (!pictures) return json(404, null);
    const sent = method === 'PUT' ? await readBytes(req, MAX_SENT_BYTES) : null;
    if (sent === TOO_BIG) return void res.writeHead(413, { connection: 'close' }).end();
    const me = await accounts.who(req.headers);
    if (!me) return json(401, { ways: accounts.ways });
    const id = sent ? await pictures.put(sent) : null;
    if (method === 'PUT' && !id) return json(400, null);
    // (Asked again: the account may have gone while the picture was drawn. Then it is not kept.)
    if (!(await accounts.who(req.headers))) return (pictures.remove(id), json(401, { ways: accounts.ways }));
    pictures.remove(accounts.repicture(me.id, id));
    const now = await accounts.who(req.headers);
    if (now) changed(now);
    json(200, now);
  }
}

const TOO_BIG = Symbol('too big');

/**
 * What a request carries: `TOO_BIG` for more than `max` bytes, said or sent. (A body may come with no size said: over
 * HTTP/2, or chunked, as Fly's proxy passes such a one on. It is read as far as `max`, like any other.)
 */
async function readBytes(req: IncomingMessage, max: number): Promise<Buffer | typeof TOO_BIG> {
  if (Number(req.headers['content-length']) > max) return TOO_BIG;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) return TOO_BIG;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** The JSON a request carries: null for none that reads, `TOO_BIG` for more than a profile is. */
async function read(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(req, MAX_BODY_BYTES);
  if (bytes === TOO_BIG) return TOO_BIG;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}
