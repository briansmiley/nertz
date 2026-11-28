// Frame-rate logs (shared/perf.ts): a window with the readout on posts what it recorded, and the last few are kept as
// files beside the database, to be read back by whoever is measuring this build on a real device. Nothing in them is
// anyone's: frame times, what the server sent (types and sizes, not contents), and the device as the browser names it.
//
//   POST /perf-logs        a log; answered with its id
//   GET  /perf-logs        the ids kept, newest first, each with when it came and its summary
//   GET  /perf-logs/<id>   one log, as it came, with what the server adds (`received`, `image`)
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PERF_LOGS_PATH, PERF_LOG_MAX_BYTES, type PerfLog } from '../shared/perf';
import { readBytes, TOO_BIG } from './profile';

/** This many are kept: a new one beyond it puts out the oldest (at most about 90 MB). */
const KEPT = 30;
/** Per address: this many logs in this long. */
const RATE_MAX = 20;
const RATE_WINDOW_MS = 10 * 60_000;
const ID = /^\d{13}-[0-9a-f]{8}$/;

/** Whether `v` is a log as a window sends one: checked as far as reading it back relies on. */
export function isPerfLog(v: unknown): v is PerfLog {
  if (!v || typeof v !== 'object') return false;
  const l = v as Partial<PerfLog>;
  return (
    typeof l.host === 'string' &&
    typeof l.at === 'number' &&
    typeof l.ms === 'number' &&
    Array.isArray(l.frames) &&
    l.frames.every((f) => typeof f === 'number') &&
    Array.isArray(l.events) &&
    !!l.summary &&
    typeof l.summary.fps === 'number' &&
    typeof l.summary.low === 'number'
  );
}

const json = (res: ServerResponse, status: number, body: unknown): void =>
  void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));

/** The handler for `/perf-logs` and below, keeping logs in `dir` (made if it is not there). */
export function perfLogHandler(dir: string, image: string | null): (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void> {
  mkdirSync(dir, { recursive: true });
  const sent = new Map<string, number[]>();
  const ids = (): string[] =>
    readdirSync(dir)
      .filter((f) => f.endsWith('.json') && ID.test(f.slice(0, -5)))
      .map((f) => f.slice(0, -5))
      .sort()
      .reverse();

  return async (req, res, path) => {
    if (path === PERF_LOGS_PATH && req.method === 'POST') {
      const from = String(req.headers['fly-client-ip'] ?? req.socket.remoteAddress ?? '');
      const now = Date.now();
      const recent = (sent.get(from) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
      if (recent.length >= RATE_MAX) return json(res, 429, { ok: false });
      const bytes = await readBytes(req, PERF_LOG_MAX_BYTES);
      if (bytes === TOO_BIG) return json(res, 413, { ok: false });
      let log: unknown;
      try {
        log = JSON.parse(bytes.toString('utf8'));
      } catch {
        return json(res, 400, { ok: false });
      }
      if (!isPerfLog(log)) return json(res, 400, { ok: false });
      sent.set(from, [...recent, now]);
      const id = `${now}-${randomBytes(4).toString('hex')}`;
      writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...log, received: now, image }));
      // What the list shows, beside it, so listing them never reads every log through.
      writeFileSync(join(dir, `${id}.meta`), JSON.stringify({ id, received: now, host: log.host, ms: log.ms, summary: log.summary, device: log.device?.ua ?? '' }));
      for (const old of ids().slice(KEPT)) for (const ext of ['json', 'meta']) rmSync(join(dir, `${old}.${ext}`), { force: true });
      return json(res, 200, { ok: true, id });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false });
    if (path === PERF_LOGS_PATH) {
      const list = ids().map((id) => {
        try {
          return JSON.parse(readFileSync(join(dir, `${id}.meta`), 'utf8')) as unknown;
        } catch {
          return { id, received: Number(id.slice(0, 13)) };
        }
      });
      return json(res, 200, list);
    }
    const id = path.slice(PERF_LOGS_PATH.length + 1);
    if (!ID.test(id)) return json(res, 404, null);
    let log: Buffer;
    try {
      log = readFileSync(join(dir, `${id}.json`));
    } catch {
      return json(res, 404, null);
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(log);
  };
}
