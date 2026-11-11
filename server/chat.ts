// The social side of one table: text chat, the host's two switches, who is in
// voice, and the relay for WebRTC signalling. Like the room it does no IO, and
// none of it is part of the game: nothing here ever goes into a snapshot.
import { CHAT_HISTORY, CHAT_RATE_COUNT, CHAT_RATE_MS, type ChatLine, type SocialClientMsg, type SocialServerMsg } from '../shared/chat';
import type { Conn } from './room';

/** As much of a seated player as chat needs. A player without a connection (away, or a bot) is simply never sent anything. */
export interface Member {
  seat: number;
  name: string;
  conn: Conn | null;
}

export class Social {
  /** The host's switches. To merge into a generic table-settings object, keep these two booleans there instead. */
  text = true;
  voice = true;

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

  handle(member: Member, members: readonly Member[], isHost: boolean, msg: SocialClientMsg): void {
    switch (msg.t) {
      case 'chat':
        return this.say(member, members, msg.text);
      case 'social': {
        if (!isHost) return;
        this.text = msg.text ?? this.text;
        this.voice = msg.voice ?? this.voice;
        if (!this.voice) this.inVoice.clear(); // everyone is out at once; nobody is put back in when it returns
        return this.announce(members);
      }
      case 'voice': {
        if (!this.voice) return;
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
    if (!this.text) return; // switched off: refused, and the history stays as it is
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

  private state(): SocialServerMsg {
    return { t: 'social', text: this.text, voice: this.voice, inVoice: [...this.inVoice].map(([m, muted]) => ({ seat: m.seat, muted })) };
  }

  private announce(members: readonly Member[]): void {
    const msg = this.state();
    for (const m of members) m.conn?.send(msg);
  }
}
