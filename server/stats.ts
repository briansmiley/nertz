// Records, for someone signed in (server/rounds.ts): `GET /stats` is theirs, by their cookie; `GET /stats/<handle>`
// the page of whoever `handle` is (`Page`): their record, and the asker's against them. Either over the rounds
// `?among=` says (every one, unless it says). Only someone signed in sees anyone's: nobody else is told whose a handle is.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHandle } from '../shared/protocol';
import { AMONG, type Page } from '../shared/types';
import type { Accounts } from './accounts';
import type { Rounds } from './rounds';

export const STATS_PATH = '/stats';

export function statsHandler({ accounts, rounds }: { accounts: Accounts; rounds: Rounds }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    if (req.method !== 'GET') return json(405, null);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const among = AMONG.find((a) => a === (url.searchParams.get('among') ?? 'all'));
    if (!among) return json(400, null);
    /** Whose page is asked for: none, for one's own record. */
    const handle = url.pathname === STATS_PATH ? null : url.pathname.slice(STATS_PATH.length + 1);
    if (handle !== null && !isHandle(handle)) return json(404, null);
    const me = await accounts.who(req.headers);
    if (!me) return json(401, null);
    if (handle === null) return json(200, rounds.stats(me.id, among));
    const them = accounts.whose(handle);
    if (!them) return json(404, null);
    const page: Page = { name: them.name, stats: rounds.stats(them.id, among), versus: them.id === me.id ? null : rounds.versus(me.id, them.id, among) };
    json(200, page);
  };
}
