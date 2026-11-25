// The home page's list of tables: what one room says of itself (`Room.summary`), and `GET /tables` over real HTTP,
// with real sockets sitting at the tables.
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { MAX_PLAYERS, parseClientMsg } from '../shared/protocol';
import { wire } from '../shared/testkit';
import type { OpenTables } from '../shared/types';
import { startServer, type NertzServer } from './index';
import { Room, type Conn } from './room';
import { Client, FakeConn, roomWith } from './testkit';

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

describe('a private table', () => {
  it('is the host\'s to make, at any time, by a message of its own; everyone is told, and it stays private over a restart', () => {
    expect(parseClientMsg({ t: 'unlisted', on: true })).toEqual({ t: 'unlisted', on: true });
    expect(parseClientMsg({ t: 'unlisted', on: false })).toEqual({ t: 'unlisted', on: false });
    for (const on of ['true', 1, 0, null, undefined]) expect(parseClientMsg({ t: 'unlisted', on }), String(on)).toBeNull();

    const { room, conns } = roomWith(2);
    const [host, guest] = conns as [FakeConn, FakeConn];
    room.flush();
    expect(guest.room.unlisted).toBe(false); // (public, to begin with)
    room.handle(guest, { t: 'unlisted', on: true }); // not theirs
    expect(room.unlisted).toBe(false);
    room.handle(host, { t: 'start' }); // a round on: still the host's to change
    room.handle(host, { t: 'unlisted', on: true });
    room.flush();
    expect(guest.room.unlisted).toBe(true);

    const back = Room.restored(wire(room.kept()), { schedule: () => {} })!;
    room.close();
    expect(back.unlisted).toBe(true);
    back.close();
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
    server = await startServer({ port: 0, listAfterMs: 0 });
    const port = server.port;
    const get = async (): Promise<OpenTables & { text: string }> => {
      const res = await fetch(`http://127.0.0.1:${port}/tables`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const text = await res.text();
      const body = JSON.parse(text) as OpenTables;
      expect(body.open).toBe(body.tables.length); // (fewer than twenty: every one is listed)
      return { text, ...body };
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
    expect((await get()).open).toBe(1);

    expect((await fetch(`http://127.0.0.1:${port}/tables`, { method: 'POST', body: '{}' })).status).toBe(405);
    const head = await fetch(`http://127.0.0.1:${port}/tables`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  it('leaves a private table off the list and out of the count, and lists it again once it is public; a new table only after a few seconds', async () => {
    server = await startServer({ port: 0, listAfterMs: 1500 });
    const port = server.port;
    const get = async () => (await (await fetch(`http://127.0.0.1:${port}/tables`)).json()) as OpenTables;
    const ann = await Client.open(port, null, 'Ann');
    const bob = await Client.open(port, null, 'Bob');
    sockets.push(ann.ws, bob.ws);
    expect(await get()).toEqual({ open: 0, tables: [] }); // (just opened: not yet)
    ann.send({ t: 'unlisted', on: true });
    await vi.waitFor(() => expect(server!.rooms.get(ann.code)?.unlisted).toBe(true));
    await vi.waitFor(async () => expect((await get()).tables.map((t) => t.code)).toEqual([bob.code]), { timeout: 5000 });
    expect((await get()).open).toBe(1);

    ann.send({ t: 'unlisted', on: false });
    await vi.waitFor(async () => expect((await get()).tables.map((t) => t.code).sort()).toEqual([ann.code, bob.code].sort()));
    expect((await get()).open).toBe(2);

    // Its code still lets anyone in, private or not.
    ann.send({ t: 'unlisted', on: true });
    await vi.waitFor(() => expect(server!.rooms.get(ann.code)?.unlisted).toBe(true));
    const cy = await Client.open(port, ann.code, 'Cy');
    sockets.push(cy.ws);
    expect(cy.code).toBe(ann.code);
  });

  it('lists at most twenty, and counts them all', async () => {
    server = await startServer({ port: 0, listAfterMs: 0 });
    const port = server.port;
    for (let i = 0; i < 22; i++) sockets.push((await Client.open(port, null, `P${i}`)).ws);
    const res = await fetch(`http://127.0.0.1:${port}/tables`);
    const { tables, open } = (await res.json()) as OpenTables;
    expect(server.rooms.size).toBe(22);
    expect(open).toBe(22);
    expect(tables).toHaveLength(20);
    expect(new Set(tables.map((t) => t.code)).size).toBe(20);
  });
});
