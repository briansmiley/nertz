// The social side of one table: text chat, the host's two switches, who is in
// voice, and the relay for WebRTC signalling. Like the room it does no IO, and
// none of it is part of the game: nothing here ever goes into a snapshot.
import { CHAT_HISTORY, CHAT_RATE_COUNT, CHAT_RATE_MS, type ChatEvent, type ChatLine, type IceServer, type Scored, type SocialClientMsg, type SocialServerMsg } from '../shared/chat';
import { MAX_PLAYERS, MAX_WATCHERS } from '../shared/protocol';
import type { RoundLine, RoundResult } from '../shared/types';
import type { Conn } from './room';

/** As much of someone in the room as chat needs. One without a connection (away, or a bot) is simply never sent anything; one without a seat is watching. */
export interface Member {
  id: number;
  seat: number | null;
  name: string;
  conn: Conn | null;
}

/**
 * The servers voice connections are set up through, if this server was told of any (the environment's `ICE_SERVERS`:
 * a JSON list like `[{"urls":"turn:host:3478","username":"u","credential":"p"}]`). They are passed on to every
 * client, which uses them besides its own; without a TURN server among them, two players who are both behind strict
 * networks (many phone networks) cannot hear each other.
 */
function iceFromEnv(): IceServer[] | undefined {
  try {
    const v: unknown = JSON.parse(process.env.ICE_SERVERS ?? 'null');
    return Array.isArray(v) && v.length ? (v as IceServer[]) : undefined;
  } catch {
    return undefined;
  }
}
const ICE = iceFromEnv();

/**
 * The notice that round `round` is over, from its score sheet and with its numbers. Whoever scored most is picked
 * among the lines the sheet shows (not one sent away since, `gone`); whoever got Nertz is named whatever became of them.
 */
export function roundOver(round: number, result: RoundResult): Extract<ChatEvent, { k: 'over' }> {
  const scored = (l: RoundLine): Scored => ({ who: l.id, name: l.name, points: l.delta });
  const shown = result.scores.filter((l) => !l.gone);
  const most = Math.max(...shown.map((l) => l.delta));
  const { end } = result;
  // (Whoever got Nertz was dealt in, so the round has a line for each of them.)
  const out = end.by === 'nertz' ? end.out.map((seat) => scored(result.scores.find((l) => l.seat === seat)!)) : end.by;
  return { k: 'over', round, end: out, best: shown.filter((l) => l.delta === most).map(scored) };
}

/**
 * What one sender may relay in signals: a whole table joining voice at once, and no more. To each of the other
 * (MAX_PLAYERS + MAX_WATCHERS - 1 = 29) an offer or answer of about 3.5 KB and up to 16 candidates of about
 * 0.4 KB each, so some 10 KB a pair and 12 KB with room for their escaping: 29 * 12 KB = 348 KB of burst. It is
 * refilled over 5 seconds, about 70 KB/s, which is what carries an ICE restart's new offer and candidates later on;
 * that is a fourteenth of the 1 MB/s or so one connection could send before (60 messages a second of 16 KB), and the
 * burst is well below the 1 MB a receiver may fall behind by (MAX_BUFFERED_BYTES in index.ts). A signal is charged
 * as it is relayed, escaped as JSON, since that is what lands in the receiver's buffer.
 */
export const SIGNAL_BURST_BYTES = (MAX_PLAYERS + MAX_WATCHERS - 1) * 12_000;
const SIGNAL_REFILL_PER_MS = SIGNAL_BURST_BYTES / 5000;

export class Social {
  /** The host's switches. To merge into a generic table-settings object, keep these four booleans there instead. */
  text = true;
  voice = true;
  /** And whether those watching (no seat) may take part in each. */
  watchText = true;
  watchVoice = true;

  private lines: ChatLine[] = [];
  private nextId = 1;
  /** When each player's recent messages were sent, for the rate limit. Keyed by player, so a reconnect does not reset it. */
  private recent = new WeakMap<Member, number[]>();
  /** How many bytes of signals each player may still send, and as of when. Keyed by player, so a reconnect does not reset it. */
  private signalBudget = new WeakMap<Member, { bytes: number; at: number }>();
  /** Who is in voice, and whether their microphone is muted. Belongs to a connection: a new socket starts outside. */
  private inVoice = new Map<Member, boolean>();

  /** `member` has a new connection (first time or a reconnect): it gets the history and the switches, once. */
  joined(member: Member, members: readonly Member[]): void {
    const wasIn = this.inVoice.delete(member);
    member.conn?.send({ t: 'chat', lines: this.lines, history: true });
    if (wasIn) this.announce(members);
    else member.conn?.send(this.state());
  }

  /** `member`'s connection is gone, or they left the table. */
  left(member: Member, members: readonly Member[]): void {
    if (this.inVoice.delete(member)) this.announce(members);
  }

  /** `member` has given up their seat to watch: out of voice, if those watching are kept out of it. */
  unseated(member: Member, members: readonly Member[]): void {
    if (!this.inVoice.has(member) || this.mayVoice(member)) return;
    this.putOut(member);
    this.announce(members);
  }

  handle(member: Member, members: readonly Member[], isHost: boolean, msg: SocialClientMsg): void {
    switch (msg.t) {
      case 'chat':
        return this.say(member, members, msg.text);
      case 'social': {
        if (!isHost) return;
        this.text = msg.text ?? this.text;
        this.voice = msg.voice ?? this.voice;
        this.watchText = msg.watchText ?? this.watchText;
        this.watchVoice = msg.watchVoice ?? this.watchVoice;
        // Voice switched off puts everyone out at once, and off for those watching puts them out; nobody is put back in when it returns.
        for (const m of [...this.inVoice.keys()]) if (!this.mayVoice(m)) this.putOut(m);
        return this.announce(members);
      }
      case 'voice': {
        if (msg.on && !this.mayVoice(member)) return this.putOut(member);
        if (msg.on) this.inVoice.set(member, msg.muted);
        else if (!this.inVoice.delete(member)) return;
        return this.announce(members);
      }
      case 'signal': {
        // Only between two players of this table who have both joined voice.
        const to = members.find((m) => m.id === msg.to);
        if (!this.voice || !to || to === member || !this.inVoice.has(member) || !this.inVoice.has(to)) return;
        if (!this.spendSignal(member, msg.data)) return;
        to.conn?.send({ t: 'signal', from: member.id, data: msg.data });
      }
    }
  }

  /** Whether `member` may relay `data` now; if so, it is taken from their budget. */
  private spendSignal(member: Member, data: string): boolean {
    const now = Date.now();
    const b = this.signalBudget.get(member) ?? { bytes: SIGNAL_BURST_BYTES, at: now };
    b.bytes = Math.min(SIGNAL_BURST_BYTES, b.bytes + (now - b.at) * SIGNAL_REFILL_PER_MS);
    b.at = now;
    this.signalBudget.set(member, b);
    const size = Buffer.byteLength(JSON.stringify(data)); // as relayed: a control character is sent as six bytes
    if (size > b.bytes) return false;
    b.bytes -= size;
    return true;
  }

  private say(member: Member, members: readonly Member[], text: string): void {
    if (!this.text || (!this.watchText && member.seat === null)) return; // switched off (or off for those watching): refused, and the history stays as it is
    const now = Date.now();
    const recent = (this.recent.get(member) ?? []).filter((at) => now - at < CHAT_RATE_MS);
    this.recent.set(member, recent);
    if (recent.length >= CHAT_RATE_COUNT) return;
    recent.push(now);
    this.post(members, { k: 'said', by: { who: member.id, name: member.name }, text });
  }

  /**
   * The table's own notice (a snipe, a round dealt or over, the table started over), for everyone to read where the
   * chat is. While text chat is switched off there is nowhere to read it: it is neither sent nor kept.
   */
  tell(members: readonly Member[], event: Exclude<ChatEvent, { k: 'said' }>): void {
    if (this.text) this.post(members, event);
  }

  private post(members: readonly Member[], event: ChatEvent): void {
    const line: ChatLine = { ...event, id: this.nextId++, at: Date.now() };
    this.lines.push(line);
    if (this.lines.length > CHAT_HISTORY) this.lines.shift();
    for (const m of members) m.conn?.send({ t: 'chat', lines: [line], history: false });
  }

  /** Whether the host's switches let `member` into voice. */
  private mayVoice(member: Member): boolean {
    return this.voice && (this.watchVoice || member.seat !== null);
  }

  /** Put out of voice (or kept out of it) by the host's switches, and told so: a client that only saw the list without it would take that for a reconnect and ask again. */
  private putOut(member: Member): void {
    this.inVoice.delete(member);
    member.conn?.send({ t: 'outOfVoice' });
  }

  private state(): SocialServerMsg {
    return { t: 'social', text: this.text, voice: this.voice, watchText: this.watchText, watchVoice: this.watchVoice, inVoice: [...this.inVoice].map(([m, muted]) => ({ id: m.id, muted })), ...(ICE ? { ice: ICE } : {}) };
  }

  private announce(members: readonly Member[]): void {
    const msg = this.state();
    for (const m of members) m.conn?.send(msg);
  }
}
