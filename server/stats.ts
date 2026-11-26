// Records, for someone signed in (server/rounds.ts): `GET /stats` is theirs, by their cookie; `GET /stats/<handle>`
// the page of whoever `handle` is (`Page`): their record, and the asker's against them. Either over the rounds
// `?among=` says (every one, unless it says). Only someone signed in sees anyone's: nobody else is told whose a handle is.
// A page made private is its own alone: to anyone else it is as if it were nobody's.
// `POST /stats` adds to one's own record a round played offline (client/record.ts): sent by the browser it was played
// in, once that browser is back, by the account it was played signed in as. It is taken only as a round of one person
// and bots, and the person is whoever the cookie says; a round sent twice (by the id its browser gave it) is kept once.
// `GET /usage` is how much the game is played (`Usage`), for an admin alone (server/accounts.ts): to anyone else signed
// in it is not there. `?tz=` is the asker's offset from UTC, in minutes behind it, as their browser says (0 unless said);
// `?among=` counts only the rounds it says, as for a record.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NERTZ_SIZE } from '../shared/engine';
import { BOT_LEVELS, cleanName, handleOf, isRoomCode, MAX_PLAYERS } from '../shared/protocol';
import { AMONG, type Page, type RoundEnd } from '../shared/types';
import type { Accounts } from './accounts';
import { readBytes, TOO_BIG } from './profile';
import type { RoundRecord, Rounds } from './rounds';

export const STATS_PATH = '/stats';
export const USAGE_PATH = '/usage';

/** A round played offline, as its browser sends it: plenty for ten hands and every snipe there could be in a round. */
const MAX_OFFLINE_BYTES = 64 * 1024;
/** The most a round can have of anything: cards one hand plays, snipes in it, how long it is played (ms), its number at the table. */
const MOST_PLAYED = 52;
const MOST_SNIPES = 52 * MAX_PLAYERS;
const MOST_MS = 24 * 60 * 60 * 1000;
const MOST_ROUNDS = 100_000;

const whole = (n: unknown, least: number, most: number): n is number => Number.isInteger(n) && (n as number) >= least && (n as number) <= most;
const text = (v: unknown, most: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= most;

/**
 * What a browser sent as a round played offline by `account`, as a round to keep: null for anything that is not one.
 * One hand is a person's, `account`'s whatever the browser says, and every other hand (one at least) a bot's; seats,
 * players and scores hold together; the sitting it was played in is kept apart from everyone else's.
 */
export function offlineRound(v: unknown, account: string): RoundRecord | null {
  const r = v as Partial<Record<keyof RoundRecord, unknown>> | null;
  if (!r || typeof r !== 'object' || !text(r.game, 64) || typeof r.code !== 'string' || !isRoomCode(r.code) || !whole(r.number, 1, MOST_ROUNDS)) return null;
  if (typeof r.ms !== 'number' || !(r.ms >= 0 && r.ms <= MOST_MS)) return null;
  if (!Array.isArray(r.hands) || r.hands.length < 2 || r.hands.length > MAX_PLAYERS || !Array.isArray(r.snipes) || r.snipes.length > MOST_SNIPES) return null;
  const hands: RoundRecord['hands'] = [];
  for (const raw of r.hands as unknown[]) {
    const h = raw as Partial<Record<keyof RoundRecord['hands'][number], unknown>> | null;
    if (!h || typeof h !== 'object' || !whole(h.seat, 0, MAX_PLAYERS - 1) || !whole(h.player, 0, Number.MAX_SAFE_INTEGER) || typeof h.name !== 'string') return null;
    const name = cleanName(h.name);
    const bot = h.bot === null ? null : BOT_LEVELS.find((l) => l === h.bot);
    const out = h.out === null ? null : (['stood', 'left', 'kicked'] as const).find((o) => o === h.out);
    if (!name || bot === undefined || out === undefined || !whole(h.played, 0, MOST_PLAYED) || !whole(h.nertzLeft, 0, NERTZ_SIZE) || h.delta !== h.played - 2 * h.nertzLeft) return null;
    hands.push({ seat: h.seat, player: h.player, name, account: bot ? null : account, bot, out, played: h.played, nertzLeft: h.nertzLeft, delta: h.played - 2 * h.nertzLeft });
  }
  const seats = new Set(hands.map((h) => h.seat));
  if (seats.size !== hands.length || new Set(hands.map((h) => h.player)).size !== hands.length || hands.filter((h) => !h.bot).length !== 1) return null;
  const end = (r.end ?? {}) as { by?: unknown; seat?: unknown; out?: unknown; voters?: unknown };
  let ended: RoundEnd;
  if (end.by === 'jam') ended = { by: 'jam' };
  else if (end.by === 'vote' && whole(end.voters, 0, MAX_PLAYERS)) ended = { by: 'vote', voters: end.voters };
  else if (end.by === 'nertz' && seats.has(end.seat as number) && Array.isArray(end.out) && end.out.length <= hands.length && end.out.every((s) => seats.has(s as number))) ended = { by: 'nertz', seat: end.seat as number, out: [...new Set(end.out as number[])] };
  else return null;
  const snipes: RoundRecord['snipes'] = [];
  for (const raw of r.snipes as unknown[]) {
    const s = raw as { by?: unknown; of?: unknown; card?: unknown } | null;
    if (!s || !seats.has(s.by as number) || !seats.has(s.of as number) || s.by === s.of || !text(s.card, 16)) return null;
    if (snipes.some((o) => o.of === s.of && o.card === s.card)) return null;
    snipes.push({ by: s.by as number, of: s.of as number, card: s.card });
  }
  // (A sitting's id is the browser's to make: under the account's, it can be no sitting of anyone else's.)
  return { game: `${account}/${r.game}`, code: r.code, number: r.number, end: ended, ms: r.ms, hands, snipes };
}

export function statsHandler({ accounts, rounds, home }: { accounts: Accounts; rounds: Rounds; home: string | undefined }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    if (req.method === 'POST' && new URL(req.url ?? '/', 'http://localhost').pathname === STATS_PATH) return offline(req, json);
    if (req.method !== 'GET') return json(405, null);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const among = AMONG.find((a) => a === (url.searchParams.get('among') ?? 'all'));
    if (!among) return json(400, null);
    /** Whose page is asked for (in any case): none, for one's own record. */
    const handle = url.pathname === STATS_PATH ? null : handleOf(url.pathname.slice(STATS_PATH.length + 1));
    if (handle === null && url.pathname !== STATS_PATH) return json(404, null);
    const me = await accounts.who(req.headers);
    if (!me) return json(401, null);
    if (handle === null) return json(200, rounds.stats(me.id, among));
    const them = accounts.whose(handle);
    if (!them || (them.private && them.id !== me.id)) return json(404, null);
    const page: Page = { name: them.name, picture: them.picture, stats: rounds.stats(them.id, among), versus: them.id === me.id ? null : rounds.versus(me.id, them.id, among) };
    json(200, page);
  };

  /**
   * A round played offline (`{ id, account, at, round }`), for one's own record: kept, or already kept, is 200; 401 for
   * nobody signed in, and 409 for someone signed in who is not `account`, whose it is (the browser keeps it for them);
   * 400 for anything that is no such round (the browser drops it). It counts as played at `at`, or now if that is later.
   */
  async function offline(req: IncomingMessage, json: (status: number, body: unknown) => void): Promise<void> {
    if (!home || req.headers.origin !== home) return json(403, null);
    const bytes = await readBytes(req, MAX_OFFLINE_BYTES);
    if (bytes === TOO_BIG) return json(413, null);
    const me = await accounts.who(req.headers);
    if (!me) return json(401, null);
    let said: { id?: unknown; account?: unknown; at?: unknown; round?: unknown } | null;
    try {
      said = JSON.parse(bytes.toString('utf8')) as typeof said;
    } catch {
      return json(400, null);
    }
    if (!said || typeof said !== 'object' || typeof said.account !== 'string') return json(400, null);
    if (said.account !== me.id) return json(409, null);
    const round = offlineRound(said.round, me.id);
    const { id, at } = said;
    if (!round || typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id) || !whole(at, 1, Number.MAX_SAFE_INTEGER)) return json(400, null);
    rounds.keep(round, Math.min(at, Date.now()), id);
    json(200, { ok: true });
  }
}

export function usageHandler({ accounts, rounds }: { accounts: Accounts; rounds: Rounds }) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    if (req.method !== 'GET') return json(405, null);
    const asked = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const tz = Number(asked.get('tz') ?? 0);
    const among = AMONG.find((a) => a === (asked.get('among') ?? 'all'));
    const me = await accounts.who(req.headers);
    if (!me) return json(401, null);
    if (!me.admin) return json(404, null);
    if (!Number.isInteger(tz) || Math.abs(tz) > 14 * 60 || !among) return json(400, null);
    json(200, rounds.usage(tz, among));
  };
}
