// The home page's list of tables: what one room says of itself (`Room.summary`), and `GET /tables` over real HTTP,
// with real sockets sitting at the tables.
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MAX_PLAYERS } from '../shared/protocol';
import type { TableSummary } from '../shared/types';
import { startServer, type NertzServer } from './index';
import { Room, type Conn } from './room';
import { Client } from './testkit';

const quiet = (): Conn => ({ send: () => {}, close: () => {} });

describe('Room.summary', () => {
  it('says who is at the table by name, how many watch, and which round is on; nothing that says who anyone is', () => {
    const room = new Room('ABCD', { schedule: () => {} });
    const [ann, bob, cy, dee] = [quiet(), quiet(), quiet(), quiet()];
    room.join(ann, 'Ann', 'tok-ann', true);
    room.join(bob, 'Bob', 'tok-bob');
    room.handle(bob, { t: 'sit', on: true });
    room.join(cy, 'Cy', 'tok-cy');
    room.handle(cy, { t: 'sit', on: false });
    expect(room.summary()).toEqual({ code: 'ABCD', names: ['Ann', 'Bob'], seats: MAX_PLAYERS, watching: 1, round: 0, playing: false });

    room.join(dee, 'Dee', 'tok-dee');
    room.handle(dee, { t: 'sit', on: true });
    room.handle(ann, { t: 'addBot', level: 'slow' });
    room.handle(ann, { t: 'start' });
    expect(room.summary()).toMatchObject({ names: ['Ann', 'Bob', 'Dee', 'Bot Ada'], watching: 1, round: 1, playing: true });

    // Someone who left in the middle of a round holds the seat only for their cards: not at the table any more. Someone away still is.
    room.handle(bob, { t: 'leave' });
    room.disconnect(dee);
    room.disconnect(cy); // (and is not watching, away)
    expect(room.summary()).toMatchObject({ names: ['Ann', 'Dee', 'Bot Ada'], watching: 0, round: 1, playing: true });

    const text = JSON.stringify(room.summary());
    expect(text).not.toMatch(/tok-|"id"|"me"|"token"|"seat"/);
    room.close();
  });
});

describe('GET /tables', () => {
  let server: NertzServer | undefined;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await server?.close();
    server = undefined;
  });

  it('lists the tables someone is at, the latest to change first, and nothing that could be used to take a seat', async () => {
    server = await startServer({ port: 0 });
    const port = server.port;
    const get = async (): Promise<{ text: string; tables: TableSummary[] }> => {
      const res = await fetch(`http://127.0.0.1:${port}/tables`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const text = await res.text();
      return { text, tables: (JSON.parse(text) as { tables: TableSummary[] }).tables };
    };
    const open = async (room: string | null, name: string, sit = true) => {
      const s = await Client.open(port, room, name, undefined, sit);
      sockets.push(s.ws);
      return s;
    };

    expect((await get()).tables).toEqual([]);

    const ann = await open(null, 'Ann');
    const code = ann.code;
    const bob = await open(code, 'Bob');
    const cy = await open(code, 'Cy', false);
    cy.send({ t: 'sit', on: false });
    await vi.waitFor(async () => expect((await get()).tables).toEqual([{ code, names: ['Ann', 'Bob'], seats: MAX_PLAYERS, watching: 1, round: 0, playing: false }]));

    // The latest table to change comes first; a change at the other puts it back on top.
    const dee = await open(null, 'Dee');
    const other = dee.code;
    await vi.waitFor(async () => expect((await get()).tables.map((t) => t.code)).toEqual([other, code]));
    await new Promise((ok) => setTimeout(ok, 5)); // (so that the next change is later by the clock, too)
    cy.ws.send(JSON.stringify({ t: 'sit', on: true }));
    await vi.waitFor(async () => expect((await get()).tables.map((t) => t.code)).toEqual([code, other]));

    ann.ws.send(JSON.stringify({ t: 'start' }));
    await vi.waitFor(async () => expect((await get()).tables.find((t) => t.code === code)).toMatchObject({ names: ['Ann', 'Bob', 'Cy'], watching: 0, round: 1, playing: true }));

    const { text } = await get();
    for (const s of [ann, bob, cy, dee]) expect(text).not.toContain(s.token);
    expect(text).not.toMatch(/"id"|"me"|"token"|"seat"|"players"|"game"/);

    // A table nobody is at just now is kept (for whoever was there), but not listed.
    dee.ws.close();
    await vi.waitFor(() => expect(server!.rooms.get(other)?.connected).toBe(0));
    expect(server.rooms.has(other)).toBe(true);
    expect((await get()).tables.map((t) => t.code)).toEqual([code]);

    expect((await fetch(`http://127.0.0.1:${port}/tables`, { method: 'POST', body: '{}' })).status).toBe(405);
    const head = await fetch(`http://127.0.0.1:${port}/tables`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  it('lists at most twenty', async () => {
    server = await startServer({ port: 0 });
    const port = server.port;
    for (let i = 0; i < 22; i++) sockets.push((await Client.open(port, null, `P${i}`)).ws);
    const res = await fetch(`http://127.0.0.1:${port}/tables`);
    const { tables } = (await res.json()) as { tables: TableSummary[] };
    expect(server.rooms.size).toBe(22);
    expect(tables).toHaveLength(20);
    expect(new Set(tables.map((t) => t.code)).size).toBe(20);
  });
});
