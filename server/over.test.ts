// A connection the server is done with for good is closed with CLOSE_OVER and the reason for the player; nothing else says so.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
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
    expect(lost.got).toEqual([]);
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
    await vi.waitFor(() => expect(got).toEqual([{ t: 'pong' }]));
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
