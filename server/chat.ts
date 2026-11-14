// The social side of one table: text chat, the host's two switches, who is in
// voice, and the relay for WebRTC signalling. Like the room it does no IO, and
// none of it is part of the game: nothing here ever goes into a snapshot.
import { CHAT_HISTORY, CHAT_RATE_COUNT, CHAT_RATE_MS, type ChatLine, type IceServer, type SocialClientMsg, type SocialServerMsg } from '../shared/chat';
import type { Conn } from './room';

/** As much of a seated player as chat needs. A player without a connection (away, or a bot) is simply never sent anything. */
export interface Member {
  seat: number;
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

export class Social {
  /** The host's switches. To merge into a generic table-settings object, keep these two booleans there instead. */
  text = true;
  voice = true;
  /** And whether those watching a full table (a seat number past the table's: `isWatching`) may take part in each. */
  watchText = true;
  watchVoice = true;
  /** Is this member only watching? Told by the room, which knows what a seat number means. */
  isWatching: (m: Member) => boolean = () => false;

  private lines: ChatLine[] = [];
  private nextId = 1;
  /** When each player's recent messages were sent, for the rate limit. Keyed by player, so a reconnect does not reset it. */
  private recent = new WeakMap<Member, number[]>();
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

  /**
   * `member` took another seat (it was `from`). What they said goes with them, so that it is not shown in the colour
   * of whoever sits there next; and if they were in voice they are put out of it, since every connection there is
   * known by its seat: their window sees that it is no longer in, and joins again from the new one.
   */
  moved(member: Member, from: number, members: readonly Member[]): void {
    if (this.lines.some((l) => l.seat === from && l.name === member.name)) {
      this.lines = this.lines.map((l) => (l.seat === from && l.name === member.name ? { ...l, seat: member.seat } : l));
      for (const m of members) m.conn?.send({ t: 'chat', lines: this.lines, history: true });
    }
    if (this.inVoice.delete(member)) this.announce(members);
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
        if (!this.voice) this.inVoice.clear(); // everyone is out at once; nobody is put back in when it returns
        else if (!this.watchVoice) for (const m of [...this.inVoice.keys()]) if (this.isWatching(m)) this.inVoice.delete(m); // those watching are put out
        return this.announce(members);
      }
      case 'voice': {
        if (!this.voice || (msg.on && !this.watchVoice && this.isWatching(member))) return;
        if (msg.on) this.inVoice.set(member, msg.muted);
        else if (!this.inVoice.delete(member)) return;
        return this.announce(members);
      }
      case 'signal': {
        // Only between two players of this table who have both joined voice.
        const to = members.find((m) => m.seat === msg.to);
        if (!this.voice || !to || to === member || !this.inVoice.has(member) || !this.inVoice.has(to)) return;
        to.conn?.send({ t: 'signal', from: member.seat, data: msg.data });
      }
    }
  }

  private say(member: Member, members: readonly Member[], text: string): void {
    if (!this.text || (!this.watchText && this.isWatching(member))) return; // switched off (or off for those watching): refused, and the history stays as it is
    const now = Date.now();
    const recent = (this.recent.get(member) ?? []).filter((at) => now - at < CHAT_RATE_MS);
    this.recent.set(member, recent);
    if (recent.length >= CHAT_RATE_COUNT) return;
    recent.push(now);
    const line: ChatLine = { id: this.nextId++, seat: member.seat, name: member.name, text, at: now };
    this.lines.push(line);
    if (this.lines.length > CHAT_HISTORY) this.lines.shift();
    for (const m of members) m.conn?.send({ t: 'chat', lines: [line], history: false });
  }

  /** The table's own notice, for everyone to read where the chat is: `by` beat `of` to a pile. (Not while text chat is switched off: there is nowhere to read it.) */
  sniped(members: readonly Member[], by: Member, of: Member): void {
    if (!this.text) return;
    const line: ChatLine = { id: this.nextId++, seat: by.seat, name: by.name, text: '', at: Date.now(), sniped: { seat: of.seat, name: of.name } };
    this.lines.push(line);
    if (this.lines.length > CHAT_HISTORY) this.lines.shift();
    for (const m of members) m.conn?.send({ t: 'chat', lines: [line], history: false });
  }

  private state(): SocialServerMsg {
    return { t: 'social', text: this.text, voice: this.voice, ...(this.watchText ? {} : { watchText: false }), ...(this.watchVoice ? {} : { watchVoice: false }), inVoice: [...this.inVoice].map(([m, muted]) => ({ seat: m.seat, muted })), ...(ICE ? { ice: ICE } : {}) };
  }

  private announce(members: readonly Member[]): void {
    const msg = this.state();
    for (const m of members) m.conn?.send(msg);
  }
}
