// One game room. No IO, no clock: it is handed parsed messages for opaque
// connection handles and decides what each connection is sent.
//
// Concurrency: every method runs to completion on Node's single thread, so the
// order in which messages arrive IS the order of play. An intent is applied to
// the authoritative state or rejected, the sender's `ack` advances either way,
// and one full snapshot per player goes out per event-loop turn (`flush`).
import { applyIntent, deal, resolveStuck, scoreRound, viewFor, type Rng } from '../shared/engine';
import { MAX_PLAYERS, MIN_PLAYERS, type ClientMsg, type ServerMsg } from '../shared/protocol';
import type { GameState, Phase, RoomView, RoundResult } from '../shared/types';

/** A live client connection, as far as a room cares. */
export interface Conn {
  send(msg: ServerMsg): void;
  /** Called when another connection takes over this one's seat (same token). */
  close(): void;
}

interface Player {
  /** Secret chosen by the client; maps a reconnect back to its seat. Never sent to anyone. */
  token: string;
  name: string;
  seat: number;
  score: number;
  conn: Conn | null;
  /** Highest intent seq processed from the current connection (-1 = none yet). */
  ack: number;
  /** Owes this player a snapshot at the next flush. */
  dirty: boolean;
  /** Left on purpose mid-game: keeps the seat until the next round is dealt. */
  left: boolean;
}

export interface RoomOptions {
  rng?: Rng;
  /** How to defer the coalesced flush; defaults to once per event-loop turn. */
  schedule?: (flush: () => void) => void;
}

export class Room {
  phase: Phase = 'lobby';
  round = 0;
  /** Bumped on every change, including a rejected intent (its sender's ack changed). */
  rev = 0;
  /** The authoritative round, every card known. Null in the lobby; kept through 'results'. */
  game: GameState | null = null;
  lastRound: RoundResult | null = null;

  private players: Player[] = []; // in seat order
  private conns = new Map<Conn, Player>();
  /** Whoever opened the room. See `dealer` for who may actually start a round. */
  private host: Player | null = null;
  private flushScheduled = false;
  private readonly rng: Rng;
  private readonly schedule: (flush: () => void) => void;

  constructor(
    readonly code: string,
    options: RoomOptions = {},
  ) {
    this.rng = options.rng ?? Math.random;
    this.schedule = options.schedule ?? setImmediate;
  }

  /** Number of live connections. */
  get connected(): number {
    return this.conns.size;
  }

  /** True when nobody is seated any more (everyone left from the lobby). */
  get empty(): boolean {
    return this.players.length === 0;
  }

  /** Seats `conn`, or re-attaches it to the seat its token already holds. Returns an error message on refusal. */
  join(conn: Conn, name: string, token: string): string | null {
    if (this.conns.has(conn)) this.drop(conn, false);
    let player = this.players.find((p) => p.token === token);
    if (!player) {
      if (this.phase === 'playing') return 'A round is in progress. Try again when it ends.';
      if (this.players.length >= MAX_PLAYERS) return 'That room is full.';
      let seat = 0;
      while (this.players.some((p) => p.seat === seat)) seat++;
      player = { token, name, seat, score: 0, conn: null, ack: -1, dirty: false, left: false };
      this.players.push(player);
      this.players.sort((a, b) => a.seat - b.seat);
    } else if (player.conn) {
      // Same token from a second socket (duplicated tab, or a reconnect racing the old socket's close): newest wins.
      const old = player.conn;
      this.conns.delete(old);
      old.close();
    }
    Object.assign(player, { name, conn, ack: -1, left: false });
    this.conns.set(conn, player);
    this.host ??= player;
    this.changed();
    return null;
  }

  /** Any message other than `join` from a connection that has joined. Unknown connections are ignored. */
  handle(conn: Conn, msg: Exclude<ClientMsg, { t: 'join' }>): void {
    const player = this.conns.get(conn);
    if (!player) return;
    switch (msg.t) {
      case 'start':
        return this.start(player);
      case 'intent':
        return this.intent(player, msg.seq, msg.intent);
      case 'leave':
        return this.drop(conn, true);
    }
  }

  /** The socket went away. The player stays seated and can come back with the same token. */
  disconnect(conn: Conn): void {
    this.drop(conn, false);
  }

  /** Sends every player who is owed one their latest snapshot. Runs once per event-loop turn. */
  flush(): void {
    this.flushScheduled = false;
    for (const p of this.players) {
      if (!p.dirty) continue;
      p.dirty = false;
      p.conn?.send({ t: 'state', rev: this.rev, ack: p.ack, room: this.view(p) });
    }
  }

  // ------------------------------------------------------------ internals

  /**
   * Who may start a round: the host, or while the host has no live connection
   * the first connected player. The role returns to the host when they do
   * (a reload must not cost them the table).
   */
  private get dealer(): Player | null {
    return this.host?.conn ? this.host : (this.players.find((p) => p.conn) ?? this.host);
  }

  private start(player: Player): void {
    // Only people who are here get cards. Someone away keeps their seat and score and sits the round out.
    const dealt = this.players.filter((p) => p.conn);
    if (player !== this.dealer || this.phase === 'playing' || dealt.length < MIN_PLAYERS) return;
    this.players = this.players.filter((p) => !p.left);
    if (!this.host || !this.players.includes(this.host)) this.host = player;
    this.round++;
    this.game = deal(
      dealt.map((p) => p.seat),
      this.rng,
    );
    this.phase = 'playing';
    this.changed();
  }

  private intent(player: Player, seq: number, intent: Extract<ClientMsg, { t: 'intent' }>['intent']): void {
    if (seq <= player.ack) return; // duplicate or out of order: already answered
    player.ack = seq;
    const result = this.phase === 'playing' && this.game ? applyIntent(this.game, player.seat, intent) : null;
    if (!result?.ok) return this.changed(player); // rejected: only the sender needs to hear (its ack moved)
    this.game = result.state;
    this.settle();
    this.changed();
  }

  /** After anything that can end the round or complete an "everyone is stuck" vote. */
  private settle(): void {
    if (this.phase !== 'playing' || !this.game) return;
    this.game = resolveStuck(this.game, this.connectedSeats());
    if (this.game.nertzCalledBy === null) return;
    const scores = scoreRound(this.game);
    for (const s of scores) {
      const p = this.players.find((p) => p.seat === s.seat);
      if (p) p.score += s.delta;
    }
    this.lastRound = { calledBy: this.game.nertzCalledBy, scores };
    this.phase = 'results';
  }

  private drop(conn: Conn, leaving: boolean): void {
    const player = this.conns.get(conn);
    if (!player) return;
    this.conns.delete(conn);
    player.conn = null;
    if (leaving && this.phase === 'lobby') {
      this.players = this.players.filter((p) => p !== player);
      if (this.host === player) this.host = this.players.find((p) => p.conn) ?? this.players[0] ?? null;
    } else if (leaving) {
      player.left = true; // their cards are on the table; the seat is freed when the next round is dealt
    }
    this.settle(); // the remaining connected players may now all be stuck
    this.changed();
  }

  private connectedSeats(): number[] {
    return this.players.filter((p) => p.conn).map((p) => p.seat);
  }

  /** Records a change: bumps rev, marks who is owed a snapshot (default everyone) and schedules one flush. */
  private changed(only?: Player): void {
    this.rev++;
    for (const p of only ? [only] : this.players) p.dirty = true;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => this.flush());
  }

  private view(you: Player): RoomView {
    const game = this.game && viewFor(this.game, you.seat);
    const dealer = this.dealer;
    const stuck = (seat: number) => this.phase === 'playing' && !!game?.players.find((g) => g.seat === seat)?.stuck;
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      you: you.seat,
      players: this.players.map((p) => ({
        seat: p.seat,
        name: p.name,
        connected: p.conn !== null,
        score: p.score,
        isHost: p === dealer,
        stuck: stuck(p.seat),
      })),
      game,
      lastRound: this.lastRound,
    };
  }
}
