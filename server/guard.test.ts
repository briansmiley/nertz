// What a room throws where no message handler is underneath it (its timers, its snapshots, a socket's close) is
// logged, and the process, and every other table in it, carries on.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { DEAL_MS, START_MS, type ServerMsg } from '../shared/protocol';
import { startServer } from './index';
import { Room, type Conn } from './room';
import { FakeConn, type StateMsg } from './testkit';

/** Silences what the guard logs, so the test setup (server/testsetup.ts) lets it pass, and records it to look at. */
const logged = () => vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a room', () => {
  it('logs what a timer throws, and carries on', () => {
    vi.useFakeTimers();
    const errors = logged();
    let broken = false;
    let x = 7;
    const room = new Room('TEST', {
      rng: () => {
        if (broken) throw new Error('boom');
        return ((x = (x * 16807) % 2147483647) - 1) / 2147483646;
      },
      schedule: () => {},
    });
    const host = new FakeConn();
    expect(room.join(host, 'Ann', randomUUID(), true)).toBeNull();
    room.handle(host, { t: 'addBot', level: 'medium' });
    room.handle(host, { t: 'start' });
    vi.advanceTimersByTime(DEAL_MS);
    room.handle(host, { t: 'go' });
    broken = true; // the bot wakes when play opens, and its first pause is a roll of the dice
    expect(() => vi.advanceTimersByTime(START_MS)).not.toThrow();
    expect(errors).toHaveBeenCalledWith('error in table TEST', expect.objectContaining({ message: 'boom' }));

    // The table is still there to be dealt over.
    broken = false;
    room.handle(host, { t: 'redeal' });
    vi.advanceTimersByTime(DEAL_MS);
    room.flush();
    expect(host.states.at(-1)?.room.game?.stage).toBe('ready');
  });

  it('sends everyone else their snapshot when one of them cannot be sent', () => {
    const errors = logged();
    const flushes: (() => void)[] = [];
    const room = new Room('TEST', { schedule: (flush) => void flushes.push(flush) });
    const bad: Conn = {
      send: (msg) => {
        if (msg.t === 'state') throw new Error('boom');
      },
      close: () => {},
    };
    const good = new FakeConn();
    expect(room.join(bad, 'Ann', randomUUID(), true)).toBeNull();
    expect(room.join(good, 'Bob', randomUUID())).toBeNull();
    expect(flushes).toHaveLength(1);
    expect(() => flushes[0]!()).not.toThrow();
    expect(errors).toHaveBeenCalledWith('error in table TEST', expect.objectContaining({ message: 'boom' }));
    expect(good.states).toHaveLength(1);
  });
});

describe('the server', () => {
  it('logs what a socket closing throws, and goes on serving', async () => {
    const errors = logged();
    vi.spyOn(Room.prototype, 'disconnect').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const server = await startServer({ port: 0, dist: '/nonexistent' });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      await new Promise((ok, fail) => ws.once('open', ok).once('error', fail));
      const states: StateMsg[] = [];
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as ServerMsg;
        if (msg.t === 'state') states.push(msg);
      });
      ws.send(JSON.stringify({ t: 'create', name: 'Ann', token: randomUUID() }));
      await vi.waitFor(() => expect(states.length).toBeGreaterThan(0));
      ws.close();
      await vi.waitFor(() => expect(errors).toHaveBeenCalledWith("error in a socket's close", expect.objectContaining({ message: 'boom' })));
      const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(health.ok).toBe(true);
    } finally {
      await server.close();
    }
  });
});
