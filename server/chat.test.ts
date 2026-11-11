import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_HISTORY, CHAT_MAX_LENGTH, CHAT_RATE_COUNT, CHAT_RATE_MS, cleanChat, SIGNAL_MAX_LENGTH, type ChatLine, type SocialServerMsg } from '../shared/chat';
import { MAX_MESSAGE_BYTES, parseClientMsg, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { Room, type Conn } from './room';

type Of<T extends SocialServerMsg['t']> = Extract<SocialServerMsg, { t: T }>;

/** A connection that records the chat and voice messages it was sent (snapshots are counted only). */
class FakeConn implements Conn {
  sent: SocialServerMsg[] = [];
  states = 0;
  closed = false;
  send(msg: ServerMsg): void {
    if (msg.t === 'state') this.states++;
    else if (msg.t !== 'error') this.sent.push(JSON.parse(JSON.stringify(msg)) as SocialServerMsg);
  }
  close(): void {
    this.closed = true;
  }
  of<T extends SocialServerMsg['t']>(t: T): Of<T>[] {
    return this.sent.filter((m): m is Of<T> => m.t === t);
  }
  /** Every chat line received, in order, history included. */
  get lines(): ChatLine[] {
    return this.of('chat').flatMap((m) => m.lines);
  }
  get social(): Of<'social'> {
    return this.of('social').at(-1)!;
  }
}

function roomWith(n: number, code = 'TEST'): { room: Room; conns: FakeConn[] } {
  const room = new Room(code, { schedule: () => {} });
  const conns = Array.from({ length: n }, (_, i) => {
    const conn = new FakeConn();
    expect(room.join(conn, `P${i}`, `tok-000${i}`)).toBeNull();
    return conn;
  });
  return { room, conns };
}

/** What a client sends, through the same validation as the real server. */
function send(room: Room, conn: Conn, raw: unknown): boolean {
  const msg = parseClientMsg(JSON.stringify(raw));
  if (!msg || msg.t === 'join' || msg.t === 'create') return false;
  room.handle(conn, msg);
  return true;
}

afterEach(() => vi.useRealTimers());

describe('chat validation', () => {
  it('accepts a clean copy of well-formed messages', () => {
    expect(parseClientMsg({ t: 'chat', text: '  hi\tthere\n', extra: 1 })).toEqual({ t: 'chat', text: 'hi there' });
    expect(parseClientMsg({ t: 'social', text: false })).toEqual({ t: 'social', text: false });
    expect(parseClientMsg({ t: 'social', text: true, voice: false, x: 1 })).toEqual({ t: 'social', text: true, voice: false });
    expect(parseClientMsg({ t: 'voice', on: true, muted: false })).toEqual({ t: 'voice', on: true, muted: false });
    expect(parseClientMsg({ t: 'signal', to: 3, data: '.{}', from: 9 })).toEqual({ t: 'signal', to: 3, data: '.{}' });
  });

  it('rejects malformed ones', () => {
    const bad: unknown[] = [
      { t: 'chat' }, { t: 'chat', text: 7 }, { t: 'chat', text: '' }, { t: 'chat', text: ' \n\u0000 ' },
      { t: 'social' }, { t: 'social', text: 'no' }, { t: 'social', voice: 1 }, { t: 'social', text: true, voice: 'x' },
      { t: 'voice' }, { t: 'voice', on: true }, { t: 'voice', on: 1, muted: false },
      { t: 'signal' }, { t: 'signal', to: 1 }, { t: 'signal', to: -1, data: 'x' }, { t: 'signal', to: 1.5, data: 'x' }, { t: 'signal', to: '1', data: 'x' },
      { t: 'signal', to: 1, data: '' }, { t: 'signal', to: 1, data: { sdp: 'x' } }, { t: 'signal', to: 1, data: 'x'.repeat(SIGNAL_MAX_LENGTH + 1) },
    ]; // prettier-ignore
    for (const raw of bad) expect(parseClientMsg(raw), JSON.stringify(raw).slice(0, 60)).toBeNull();
  });

  it('caps the length and strips control characters', () => {
    const long = cleanChat('x'.repeat(CHAT_MAX_LENGTH + 50));
    expect(long).toHaveLength(CHAT_MAX_LENGTH);
    expect(cleanChat('a\u0000b\u001fc\u007fd\u2028e')).toBe('a b c d e');
    expect(cleanChat('<b>bold</b>')).toBe('<b>bold</b>'); // plain text: the client renders it as text
    expect((parseClientMsg({ t: 'chat', text: 'y'.repeat(1000) }) as Extract<ClientMsg, { t: 'chat' }>).text).toHaveLength(CHAT_MAX_LENGTH);
    // The biggest signalling piece, escaped as badly as JSON can, still fits one frame.
    expect(JSON.stringify({ t: 'signal', to: 5, data: '"'.repeat(800) }).length).toBeLessThan(MAX_MESSAGE_BYTES);
  });
});

describe('text chat', () => {
  it('stamps seat, name and a rising id, and reaches everyone at the table but nobody else', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    const other = roomWith(2, 'ELSE');
    expect(send(room, b, { t: 'chat', text: 'hello', seat: 0, name: 'Mallory', id: 99 })).toBe(true);
    send(room, a, { t: 'chat', text: 'hi' });
    for (const conn of [a, b, c]) {
      expect(conn.lines.map(({ at: _, ...l }) => l)).toEqual([
        { id: 1, seat: 1, name: 'P1', text: 'hello' },
        { id: 2, seat: 0, name: 'P0', text: 'hi' },
      ]);
    }
    expect(other.conns[0]!.lines).toEqual([]);
  });

  it('is never part of a snapshot', () => {
    const { room, conns } = roomWith(2);
    room.flush();
    const [rev, states] = [room.rev, conns[0]!.states];
    send(room, conns[0]!, { t: 'chat', text: 'not in the snapshot' });
    room.flush();
    expect(room.rev).toBe(rev);
    expect(conns[0]!.states).toBe(states);
  });

  it('drops what one player sends beyond the rate limit, quietly, and lets them speak again later', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    for (let i = 0; i < CHAT_RATE_COUNT + 3; i++) send(room, a, { t: 'chat', text: `a${i}` });
    send(room, b, { t: 'chat', text: 'b is not held back by a' });
    expect(b.lines.map((l) => l.text)).toEqual([...Array.from({ length: CHAT_RATE_COUNT }, (_, i) => `a${i}`), 'b is not held back by a']);
    // A reconnect does not reset it: the limit is per player.
    const a2 = new FakeConn();
    room.join(a2, 'P0', 'tok-0000');
    send(room, a2, { t: 'chat', text: 'still too fast' });
    expect(b.lines.at(-1)!.text).toBe('b is not held back by a');
    vi.advanceTimersByTime(CHAT_RATE_MS);
    send(room, a2, { t: 'chat', text: 'later' });
    expect(b.lines.at(-1)!.text).toBe('later');
  });

  it('keeps the last CHAT_HISTORY lines and hands them to a player who joins or reconnects, once', () => {
    vi.useFakeTimers();
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    expect(a.of('chat')).toEqual([{ t: 'chat', lines: [], history: true }]);
    for (let i = 0; i < CHAT_HISTORY + 10; i++) {
      send(room, i % 2 ? a : b, { t: 'chat', text: `m${i}` });
      vi.advanceTimersByTime(CHAT_RATE_MS);
    }
    const kept = Array.from({ length: CHAT_HISTORY }, (_, i) => `m${i + 10}`);

    const c = new FakeConn(); // a newcomer
    room.join(c, 'P2', 'tok-0002');
    expect(c.of('chat')).toHaveLength(1);
    expect(c.of('chat')[0]!.history).toBe(true);
    expect(c.lines.map((l) => l.text)).toEqual(kept);
    expect(c.lines[0]!.id).toBe(11);

    room.disconnect(b); // a reconnect
    const b2 = new FakeConn();
    room.join(b2, 'P1', 'tok-0001');
    expect(b2.of('chat')).toEqual(c.of('chat'));
    room.flush();
    send(room, a, { t: 'chat', text: 'after' });
    expect(b2.of('chat')).toHaveLength(2); // only the new line, not the history again
    expect(b2.of('chat')[1]).toMatchObject({ history: false, lines: [{ text: 'after' }] });
  });

  it('skips players without a connection', () => {
    const { room, conns } = roomWith(3);
    room.disconnect(conns[1]!);
    const before = conns[1]!.sent.length;
    send(room, conns[0]!, { t: 'chat', text: 'anyone?' });
    expect(conns[1]!.sent.length).toBe(before);
    expect(conns[2]!.lines.map((l) => l.text)).toEqual(['anyone?']);
  });
});

describe('the host switches', () => {
  it('start on, are told to everyone who sits down, and only the host can flip them', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    expect(b.social).toEqual({ t: 'social', text: true, voice: true, inVoice: [] });
    send(room, b, { t: 'social', text: false, voice: false }); // not the host
    expect(room.social.text && room.social.voice).toBe(true);
    expect(a.of('social')).toHaveLength(1);
    send(room, a, { t: 'social', voice: false });
    for (const conn of [a, b]) expect(conn.social).toEqual({ t: 'social', text: true, voice: false, inVoice: [] });
    send(room, a, { t: 'social', text: false });
    for (const conn of [a, b]) expect(conn.social).toMatchObject({ text: false, voice: false });
    // They can be flipped mid-round too: they are not game rules.
    send(room, a, { t: 'social', voice: true });
    send(room, a, { t: 'start' });
    expect(room.phase).toBe('playing');
    send(room, a, { t: 'social', text: true });
    expect(b.social).toMatchObject({ text: true, voice: true });
    room.close();
  });

  it('follow the host role when the host is away', () => {
    const { room, conns } = roomWith(2);
    room.disconnect(conns[0]!);
    send(room, conns[1]!, { t: 'social', text: false });
    expect(room.social.text).toBe(false);
  });

  it('text off refuses new messages but keeps the history, which is still handed out; on resumes with it intact', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    send(room, b, { t: 'chat', text: 'before' });
    send(room, a, { t: 'social', text: false });
    send(room, b, { t: 'chat', text: 'while off' });
    send(room, a, { t: 'chat', text: 'not even the host' });
    expect(a.lines.map((l) => l.text)).toEqual(['before']);

    const c = new FakeConn();
    room.join(c, 'P2', 'tok-0002');
    expect(c.lines.map((l) => l.text)).toEqual(['before']);
    expect(c.social).toMatchObject({ text: false });

    send(room, a, { t: 'social', text: true });
    send(room, b, { t: 'chat', text: 'after' });
    expect(c.lines.map((l) => [l.id, l.text])).toEqual([[1, 'before'], [2, 'after']]); // prettier-ignore
  });
});

describe('voice', () => {
  const join = (room: Room, ...conns: FakeConn[]) => conns.forEach((c) => send(room, c, { t: 'voice', on: true, muted: false }));

  it('tells everyone who is in voice and who is muted', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    join(room, b);
    send(room, c, { t: 'voice', on: true, muted: true });
    for (const conn of [a, b, c]) expect(conn.social.inVoice).toEqual([{ seat: 1, muted: false }, { seat: 2, muted: true }]); // prettier-ignore
    send(room, c, { t: 'voice', on: true, muted: false });
    send(room, b, { t: 'voice', on: false, muted: false });
    expect(a.social.inVoice).toEqual([{ seat: 2, muted: false }]);
  });

  it('forwards signalling only inside the table, between players in voice, with the sender seat stamped by the server', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    const other = roomWith(2, 'ELSE');
    join(other.room, ...other.conns);
    join(room, a, b);
    send(room, b, { t: 'signal', to: 0, data: '.offer', from: 2 }); // a forged sender is dropped by validation
    expect(a.of('signal')).toEqual([{ t: 'signal', from: 1, data: '.offer' }]);
    expect(b.of('signal')).toEqual([]);
    expect(c.of('signal')).toEqual([]);
    expect(other.conns.flatMap((x) => x.of('signal'))).toEqual([]);

    send(room, a, { t: 'signal', to: 2, data: '.x' }); // c has not joined voice
    send(room, c, { t: 'signal', to: 0, data: '.x' }); // nor may c signal anyone
    send(room, a, { t: 'signal', to: 0, data: '.x' }); // not to oneself
    send(room, a, { t: 'signal', to: 5, data: '.x' }); // nobody sits there
    expect(conns.flatMap((x) => x.of('signal'))).toHaveLength(1);
    // A room only ever looks at its own players, so there is no way to address another table.
    send(other.room, other.conns[0]!, { t: 'signal', to: 1, data: '.theirs' });
    expect(conns.flatMap((x) => x.of('signal'))).toHaveLength(1);
    expect(other.conns[1]!.of('signal')).toEqual([{ t: 'signal', from: 0, data: '.theirs' }]);
  });

  it('rejects oversize signalling', () => {
    const { room, conns } = roomWith(2);
    join(room, ...conns);
    expect(send(room, conns[0]!, { t: 'signal', to: 1, data: 'x'.repeat(SIGNAL_MAX_LENGTH + 1) })).toBe(false);
    expect(parseClientMsg(JSON.stringify({ t: 'signal', to: 1, data: 'x'.repeat(MAX_MESSAGE_BYTES) }))).toBeNull();
    expect(send(room, conns[0]!, { t: 'signal', to: 1, data: 'x'.repeat(SIGNAL_MAX_LENGTH) })).toBe(true);
    expect(conns[1]!.of('signal')).toHaveLength(1);
  });

  it('switching voice off puts everyone out at once, refuses joins and signalling, and nobody is put back when it returns', () => {
    const { room, conns } = roomWith(2);
    const [a, b] = conns as [FakeConn, FakeConn];
    join(room, a, b);
    send(room, a, { t: 'social', voice: false });
    for (const conn of [a, b]) expect(conn.social).toMatchObject({ voice: false, inVoice: [] });
    send(room, a, { t: 'signal', to: 1, data: '.x' });
    join(room, b);
    expect(b.of('signal')).toEqual([]);
    expect(b.social.inVoice).toEqual([]);
    send(room, a, { t: 'social', voice: true });
    expect(b.social).toMatchObject({ voice: true, inVoice: [] });
    send(room, a, { t: 'signal', to: 1, data: '.x' }); // still nobody in voice
    expect(b.of('signal')).toEqual([]);
    join(room, a, b);
    send(room, a, { t: 'signal', to: 1, data: '.x' });
    expect(b.of('signal')).toHaveLength(1);
  });

  it('a player who disconnects, is replaced by a newer socket, or leaves is out of voice', () => {
    const { room, conns } = roomWith(3);
    const [a, b, c] = conns as [FakeConn, FakeConn, FakeConn];
    join(room, a, b, c);
    room.disconnect(b);
    expect(a.social.inVoice.map((m) => m.seat)).toEqual([0, 2]);
    send(room, a, { t: 'signal', to: 1, data: '.x' }); // b is seated but away
    expect(b.of('signal')).toEqual([]);

    const c2 = new FakeConn(); // same token, second socket: it starts outside voice
    room.join(c2, 'P2', 'tok-0002');
    expect(c.closed).toBe(true);
    expect(a.social.inVoice.map((m) => m.seat)).toEqual([0]);
    expect(c2.social.inVoice.map((m) => m.seat)).toEqual([0]);
    join(room, c2);
    expect(a.social.inVoice.map((m) => m.seat)).toEqual([0, 2]);

    send(room, c2, { t: 'leave' });
    expect(a.social.inVoice.map((m) => m.seat)).toEqual([0]);
  });
});
