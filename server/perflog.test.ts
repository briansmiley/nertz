import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type NertzServer } from './index';
import type { PerfLog } from '../shared/perf';

let server: NertzServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = dir = undefined;
});

const LOG: PerfLog = {
  host: 'nertz-pr-246.fly.dev',
  device: { ua: 'iPhone', dpr: 3, w: 390, h: 844, cores: 6 },
  at: 1795800000000,
  ms: 2000,
  frames: [0, 16.7, 33.4, 120.1],
  events: [{ t: 5, k: 'msg', type: 'state', bytes: 4200, ms: 6.1 }, { t: 7, k: 'status', at: 'play' }],
  summary: { fps: 58.2, low: 31, frames: 4 },
};

describe('perf logs', () => {
  it('a log posted is kept and read back, listed newest first by its summary; what is not a log is refused', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nertz-perf-'));
    server = await startServer({ port: 0, data: join(dir, 'nertz.db') });
    const at = (p: string, init?: RequestInit) => fetch(`http://localhost:${server!.port}${p}`, init);
    const post = (body: unknown) => at('/perf-logs', { method: 'POST', body: JSON.stringify(body) });

    const first = (await (await post(LOG)).json()) as { ok: boolean; id: string };
    expect(first.ok).toBe(true);
    const second = (await (await post({ ...LOG, summary: { fps: 40, low: 12, frames: 4 } })).json()) as { id: string };

    const list = (await (await at('/perf-logs')).json()) as { id: string; host: string; summary: PerfLog['summary'] }[];
    expect(list.map((l) => l.id)).toEqual([second.id, first.id]);
    expect(list[1]).toMatchObject({ host: 'nertz-pr-246.fly.dev', summary: LOG.summary, device: 'iPhone' });

    const back = (await (await at(`/perf-logs/${first.id}`)).json()) as PerfLog & { received: number };
    expect(back.frames).toEqual(LOG.frames);
    expect(back.events).toEqual(LOG.events);
    expect(typeof back.received).toBe('number');

    expect((await post({ frames: 'no' })).status).toBe(400);
    expect((await at('/perf-logs', { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await at('/perf-logs/../nertz.db')).status).toBe(404);
    expect((await at('/perf-logs/1795800000000-deadbeef')).status).toBe(404);
  });
});
