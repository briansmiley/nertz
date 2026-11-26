// A connection the server is done with for good is closed with CLOSE_OVER and the reason for the player; nothing else says so.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { checkInvariants, viewFor } from '../shared/engine';
import { CLOSE_OVER, type ServerMsg } from '../shared/protocol';
import type { RoomView } from '../shared/types';
import { startServer, type NertzServer } from './index';

let server: NertzServer;
const sockets: WebSocket[] = [];

/** A socket that says hello and records what it is sent, and how it is closed. */
async function hello(room: string | null, name: string, token = randomUUID()) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  sockets.push(ws);
  const got: ServerMsg[] = [];
  const end: { code: number | null; reason: string } = { code: null, reason: '' };
  ws.on('message', (data) => got.push(JSON.parse(data.toString()) as ServerMsg));
  ws.on('close', (code, reason) => Object.assign(end, { code, reason: reason.toString() }));
  await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
  ws.send(JSON.stringify(room === null ? { t: 'create', name, token } : { t: 'join', room, name, token }));
  const last = (): RoomView => (got.filter((m) => m.t === 'state').at(-1) as { room: RoomView } | undefined)!.room;
  return { ws, got, end, token, last, send: (msg: unknown) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)) };
}
const taken = async (c: Awaited<ReturnType<typeof hello>>) => vi.waitFor(() => expect(c.last()).toBeTruthy());

beforeAll(async () => {
  server = await startServer({ port: 0, dist: '/nonexistent' });
});
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
});
afterAll(() => server.close());

describe('the end of a connection', () => {
  it('a join refused: closed, with why', async () => {
    const lost = await hello('ZZZZ', 'Lost');
    await vi.waitFor(() => expect(lost.end.code).toBe(CLOSE_OVER));
    expect(lost.end.reason).toMatch(/Table ZZZZ not found/);
    expect(lost.got.map((m) => m.t)).toEqual(['welcome']); // (all it was told: which start of the server it reached)
  });

  it('a hello that does not parse is a refusal too; a bad message from someone at a table is only a complaint', async () => {
    const bad = await hello(null, '   ');
    await vi.waitFor(() => expect(bad.end.code).toBe(CLOSE_OVER));
    expect(bad.end.reason).toBe('Malformed message');

    const ann = await hello(null, 'Ann');
    await taken(ann);
    ann.send('not json');
    await vi.waitFor(() => expect(ann.got.at(-1)).toEqual({ t: 'error', message: 'Malformed message' }));
    expect(ann.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('sent away by whoever deals: closed, with why, and nothing else first', async () => {
    const host = await hello(null, 'Host');
    await taken(host);
    const guest = await hello(host.last().code, 'Guest');
    await taken(guest);
    const before = guest.got.length;
    host.send({ t: 'kick', id: guest.last().me });
    await vi.waitFor(() => expect(guest.end.code).toBe(CLOSE_OVER));
    expect(guest.end.reason).toBe('You were removed from the table by whoever deals.');
    expect(guest.got.slice(before).some((m) => m.t === 'error')).toBe(false);
  });

  it('a second socket with the same token: the first is closed, with why', async () => {
    const ann = await hello(null, 'Ann');
    await taken(ann);
    const again = await hello(ann.last().code, 'Ann', ann.token);
    await taken(again);
    await vi.waitFor(() => expect(ann.end.code).toBe(CLOSE_OVER));
    expect(ann.end.reason).toBe('This seat was opened in another tab.');
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a socket that just goes away is not ended by the server: its seat waits for it', async () => {
    const ann = await hello(null, 'Ann');
    await taken(ann);
    const code = ann.last().code;
    ann.ws.terminate();
    await vi.waitFor(() => expect(server.rooms.get(code)?.connected).toBe(0));
    const back = await hello(code, 'Ann', ann.token);
    await taken(back);
    expect(back.last().seat).toBe(ann.last().seat);
    expect(back.end.code).toBeNull();
  });

  it('a ping is answered at once, at a table or not, and changes nothing at it', async () => {
    const ann = await hello(null, 'Ann');
    await taken(ann);
    const states = ann.got.filter((m) => m.t === 'state').length;
    ann.send({ t: 'ping' });
    await vi.waitFor(() => expect(ann.got.at(-1)).toEqual({ t: 'pong' }));
    expect(ann.got.filter((m) => m.t === 'state').length).toBe(states);

    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const got: unknown[] = [];
    ws.on('message', (data) => got.push(JSON.parse(data.toString())));
    await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
    ws.send(JSON.stringify({ t: 'ping' }));
    await vi.waitFor(() => expect(got).toEqual([{ t: 'welcome', boot: expect.any(String) }, { t: 'pong' }]));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a ping that says when it was sent has that handed back in its pong; one that says it wrongly is answered plain', async () => {
    const ann = await hello(null, 'Ann');
    await taken(ann);
    ann.send({ t: 'ping', at: 1234.5 });
    await vi.waitFor(() => expect(ann.got.at(-1)).toEqual({ t: 'pong', at: 1234.5 }));
    ann.send({ t: 'ping', at: 'soon' } as never);
    await vi.waitFor(() => expect(ann.got.filter((m) => m.t === 'pong')).toEqual([{ t: 'pong', at: 1234.5 }, { t: 'pong' }]));
  });
});

describe('a table taken offline', () => {
  const carried = (c: Awaited<ReturnType<typeof hello>>) => c.got.filter((m) => m.t === 'carried');
  /** Everything `c` has sent has been dealt with: nonsense is complained of in order, after all that came before. */
  const answered = async (c: Awaited<ReturnType<typeof hello>>) => {
    const n = c.got.filter((m) => m.t === 'error').length;
    c.send('?');
    await vi.waitFor(() => expect(c.got.filter((m) => m.t === 'error').length).toBeGreaterThan(n));
  };

  it('by the one person at it, with bots: handed over whole, a round on or not, and forgotten here at once', async () => {
    const ann = await hello(null, 'Ann');
    await taken(ann);
    const code = ann.last().code;
    ann.send({ t: 'addBot', level: 'fast' });
    ann.send({ t: 'addBot', level: 'slow' });
    ann.send({ t: 'start' });
    await vi.waitFor(() => expect(ann.last().phase).toBe('playing'));
    const was = ann.last();
    ann.send({ t: 'carry' });
    await vi.waitFor(() => expect(carried(ann)).toHaveLength(1));
    const { kept } = carried(ann)[0]!;
    expect(kept).toMatchObject({ code, phase: 'playing', round: 1, host: was.me });
    expect(kept.players.map((p) => [p.name, p.seat, p.bot ?? null])).toEqual(was.players.map((p) => [p.name, p.seat, p.bot ?? null]));
    expect(kept.players.find((p) => p.id === was.me)!.token).toBe(ann.token);
    expect(checkInvariants(kept.state!)).toBeNull();
    expect(viewFor(kept.state!, was.seat!)).toEqual(was.game); // (every card as it lay, the face-down ones known)
    // Its code is dead: the table is not one of the server's, nothing more is said of it, and nobody comes to it.
    expect(server.rooms.has(code)).toBe(false);
    const said = ann.got.length;
    ann.send({ t: 'pause', on: true });
    ann.send({ t: 'ping' });
    await vi.waitFor(() => expect(ann.got.slice(said).map((m) => m.t)).toEqual(['pong']));
    expect(ann.ws.readyState).toBe(WebSocket.OPEN);
    const late = await hello(code, 'Late');
    await vi.waitFor(() => expect(late.end.code).toBe(CLOSE_OVER));
    expect(late.end.reason).toBe(`Table ${code} not found.`);
  });

  it('not with anyone else in the room: at the table or watching, here or away, or gone with their cards still lying. Then nothing happens', async () => {
    const ann = await hello(null, 'Ann');
    await taken(ann);
    const code = ann.last().code;
    const refused = async () => {
      ann.send({ t: 'carry' });
      await answered(ann);
      expect(carried(ann)).toEqual([]);
      expect(server.rooms.has(code)).toBe(true);
    };
    // Someone watching.
    const bob = await hello(code, 'Bob');
    await taken(bob);
    bob.send({ t: 'sit', on: false });
    await vi.waitFor(() => expect(ann.last().players.find((p) => p.name === 'Bob')?.seat).toBeNull());
    await refused();
    // At the table, and then away.
    bob.send({ t: 'sit', on: true });
    await vi.waitFor(() => expect(ann.last().players.find((p) => p.name === 'Bob')?.seat).not.toBeNull());
    await refused();
    bob.ws.terminate();
    await vi.waitFor(() => expect(ann.last().players.find((p) => p.name === 'Bob')?.connected).toBe(false));
    await refused();
    // Gone for good in the middle of a round: their cards lie there until it is over.
    const cy = await hello(code, 'Cy');
    await taken(cy);
    cy.send({ t: 'sit', on: true });
    await vi.waitFor(() => expect(ann.last().players.find((p) => p.name === 'Cy')?.seat).not.toBeNull());
    ann.send({ t: 'kick', id: ann.last().players.find((p) => p.name === 'Bob')!.id });
    ann.send({ t: 'start' });
    await vi.waitFor(() => expect(ann.last().game?.status.at).toBe('ready'), 5000);
    ann.send({ t: 'go' });
    await vi.waitFor(() => expect(ann.last().game?.status.at).toBe('play'), 5000);
    cy.send({ t: 'leave' });
    await vi.waitFor(() => expect(ann.last().players.find((p) => p.name === 'Cy')?.left).toBe(true));
    await refused();
    // The round over, they are off the list: the table is hers alone, and goes with her.
    ann.send({ t: 'intent', seq: 0, intent: { k: 'end', on: true } });
    await vi.waitFor(() => expect(ann.last().phase).toBe('results'));
    expect(ann.last().players.map((p) => p.name)).toEqual(['Ann']);
    ann.send({ t: 'carry' });
    await vi.waitFor(() => expect(carried(ann)).toHaveLength(1));
    expect(server.rooms.has(code)).toBe(false);
  }, 15_000);

  it('asked at no table, nothing happens', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const got: ServerMsg[] = [];
    ws.on('message', (data) => got.push(JSON.parse(data.toString()) as ServerMsg));
    await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
    ws.send(JSON.stringify({ t: 'carry' }));
    ws.send(JSON.stringify({ t: 'ping' }));
    await vi.waitFor(() => expect(got.map((m) => m.t)).toEqual(['welcome', 'pong']));
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe("the server's boot", () => {
  it('every socket is told it first: the same for every socket to one start of the server, and on Fly the image it runs', async () => {
    const boots = async (s: NertzServer) => {
      const first = await Promise.all([1, 2].map(async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
        sockets.push(ws);
        return new Promise<ServerMsg>((ok) => ws.once('message', (data) => ok(JSON.parse(data.toString()) as ServerMsg)));
      }));
      return first.map((m) => (m.t === 'welcome' ? m.boot : null));
    };
    const [a, b] = await boots(server);
    expect(a).toEqual(expect.any(String));
    expect(b).toBe(a);

    vi.stubEnv('FLY_IMAGE_REF', 'registry.fly.io/nertz:deployment-01');
    const fly = await startServer({ port: 0, dist: '/nonexistent' });
    try {
      expect(await boots(fly)).toEqual(['registry.fly.io/nertz:deployment-01', 'registry.fly.io/nertz:deployment-01']);
    } finally {
      vi.unstubAllEnvs();
      for (const ws of sockets.splice(0)) ws.terminate();
      await fly.close();
    }
  });
});
