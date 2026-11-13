// One game room. No IO: it is handed parsed messages for opaque connection
// handles and decides what each connection is sent. Its only clocks are the
// deal timer and the "1, 2, 3" start timer at the opening of a round, the
// held-card grace timer at its end, and one timer per bot (see server/bot.ts); every rule about the first two lives in
// the engine.
//
// Concurrency: every method runs to completion on Node's single thread, so the
// order in which messages arrive IS the order of play. An intent is applied to
// the authoritative state or rejected, the sender's `ack` advances either way,
// and one full snapshot per player goes out per event-loop turn (`flush`).
import { applyIntent, deal, expireGrace, finishDeal, isOver, openPlay, refused, resolveEndVote, resolveStuck, scoreRound, startCountdown, viewFor, type Rng } from '../shared/engine';
import { DEAL_MS, DRAG_BURST, DRAG_RATE, GRACE_MS, MAX_PLAYERS, MIN_PLAYERS, START_MS, type ClientMsg, type DragAt, type ServerMsg } from '../shared/protocol';
import type { BotLevel, GameState, Intent, Phase, RoomView, RoundResult } from '../shared/types';
import { BOTS, chooseIntent, DEAL_STEP_MS, freshMemory, type BotMemory } from './bot';
import { DEFAULT_SETTINGS, type TableSettings } from '../shared/settings';
import { Social } from './chat';

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
  /** Left on purpose after a round: listed until the next round is dealt, or until a newcomer needs the seat. */
  left: boolean;
  /** What is left of this player's allowance of card-position reports (`drag`), and when it was last topped up. */
  drags?: { left: number; at: number };
  /** When this player last dealt a card off their stock: dealing is paced by the server, not by how fast a client can send. */
  flipped?: number;
  /** Set for a bot. A bot is a player like any other, except that its `conn` is `BOT_CONN` and it never hosts. */
  bot?: { level: BotLevel; memory: BotMemory; timer: ReturnType<typeof setTimeout> | null; pending: { intent: Intent; memory: BotMemory } | null };
}

/** What a bot has for a connection: it counts as connected and is told nothing (it looks for itself, on its timer). */
const BOT_CONN: Conn = { send: () => {}, close: () => {} };
const BOT_NAMES = ['Bot Ada', 'Bot Bix', 'Bot Cleo', 'Bot Dot', 'Bot Eli', 'Bot Fay'];

export interface RoomOptions {
  rng?: Rng;
  /** How to defer the coalesced flush; defaults to once per event-loop turn. */
  schedule?: (flush: () => void) => void;
  /** The least time between two cards a person deals off their stock (ms). 0, the default here, is no limit. */
  flipMs?: number;
}

export class Room {
  phase: Phase = 'lobby';
  round = 0;
  /** Bumped on every change, including a rejected intent (its sender's ack changed). */
  rev = 0;
  /** The authoritative round, every card known. Null in the lobby; kept through 'results'. */
  game: GameState | null = null;
  lastRound: RoundResult | null = null;
  /** House rules, read when a round is dealt. */
  settings: TableSettings = { ...DEFAULT_SETTINGS };
  /** Text chat, voice presence and the host's two chat switches. Never part of a snapshot. */
  readonly social = new Social();

  private players: Player[] = []; // in seat order
  private conns = new Map<Conn, Player>();
  /** Whoever opened the room. See `dealer` for who may actually start a round. */
  private host: Player | null = null;
  private flushScheduled = false;
  /** Running while a called round waits for held cards to land; `graceEndsAt` is its deadline (ms epoch). */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private graceEndsAt = 0;
  /** Running while a new round is being dealt out (stage `dealing`); `dealEndsAt` is its deadline (ms epoch). */
  private dealTimer: ReturnType<typeof setTimeout> | null = null;
  private dealEndsAt = 0;
  /** Running through the dealer's "1, 2, 3" (stage `countdown`); `startEndsAt` is its deadline (ms epoch). */
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private startEndsAt = 0;
  /** Who paused the round in play, if it is paused. */
  private pausedBy: Player | null = null;
  private readonly rng: Rng;
  private readonly schedule: (flush: () => void) => void;
  private readonly flipMs: number;

  constructor(
    readonly code: string,
    options: RoomOptions = {},
  ) {
    this.rng = options.rng ?? Math.random;
    this.schedule = options.schedule ?? setImmediate;
    this.flipMs = options.flipMs ?? 0;
  }

  /** Number of live connections. */
  get connected(): number {
    return this.conns.size;
  }

  /** True when nobody is seated any more (everyone left from the lobby). Bots do not count. */
  get empty(): boolean {
    return !this.players.some((p) => !p.bot);
  }

  /** Seats `conn`, or re-attaches it to the seat its token already holds. Returns an error message on refusal. */
  join(conn: Conn, name: string, token: string): string | null {
    if (this.conns.has(conn)) this.drop(conn, false);
    let player = this.players.find((p) => p.token === token);
    if (!player) {
      if (this.phase === 'playing') return 'A round is in progress. Try again when it ends.';
      const seat = this.freeSeat();
      if (seat === null) return 'That room is full.';
      player = { token, name, seat, score: 0, conn: null, ack: -1, dirty: false, left: false };
      this.players.push(player);
      this.players.sort((a, b) => a.seat - b.seat);
    } else if (player.conn) {
      // Same token from a second socket (duplicated tab, or a reconnect racing the old socket's close): newest wins.
      const old = player.conn;
      this.conns.delete(old);
      old.close();
      this.letGo(player); // whatever the old socket was dragging is not in this one's hand
    }
    Object.assign(player, { name, conn, ack: -1, left: false });
    this.conns.set(conn, player);
    this.host ??= player;
    this.social.joined(player, this.players);
    this.settle();
    this.changed();
    return null;
  }

  /** Any message other than `join`/`create` from a connection that has joined. Unknown connections are ignored. */
  handle(conn: Conn, msg: Exclude<ClientMsg, { t: 'join' | 'create' }>): void {
    const player = this.conns.get(conn);
    if (!player) return;
    switch (msg.t) {
      case 'start':
        return this.start(player);
      case 'go':
        return this.go(player);
      case 'settings':
        return this.configure(player, msg.patch);
      case 'intent':
        return this.intent(player, msg.seq, msg.intent);
      case 'drag':
        return this.dragged(player, msg);
      case 'leave':
        return this.drop(conn, true);
      case 'addBot':
        return this.addBot(player, msg.level);
      case 'removeBot':
        return this.removeBot(player, msg.seat);
      case 'pause':
        return this.pause(player, msg.on);
      default:
        return this.social.handle(player, this.players, player === this.dealer, msg);
    }
  }

  /** The socket went away. The player stays seated and can come back with the same token. */
  disconnect(conn: Conn): void {
    this.drop(conn, false);
  }

  /** The room is being forgotten: stops its timers and its bots. */
  close(): void {
    this.stopTimers();
    this.stopBots();
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
    return this.host?.conn ? this.host : (this.players.find((p) => p.conn && !p.bot) ?? this.host);
  }

  /** Table settings belong to whoever may deal, and stand still while a round is on. Anyone else is ignored. */
  private configure(player: Player, patch: Partial<TableSettings>): void {
    if (player !== this.dealer || this.phase === 'playing') return;
    this.settings = { ...this.settings, ...patch };
    this.changed();
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
      this.settings,
    );
    this.phase = 'playing';
    this.pausedBy = null;
    // The deal is a phase of its own: the engine refuses every intent and shows nobody a face until this fires.
    this.stopTimers();
    this.dealEndsAt = Date.now() + DEAL_MS;
    this.dealTimer = setTimeout(() => this.dealt(), DEAL_MS);
    this.dealTimer.unref?.();
    this.changed();
  }

  /** The deal timer fired: the work piles show their tops, and the table waits (for as long as it takes) for the dealer to press Start. */
  private dealt(): void {
    this.dealTimer = null;
    if (this.phase !== 'playing' || !this.game) return;
    this.game = finishDeal(this.game);
    this.changed();
  }

  /** Whoever may deal says "1, 2, 3...": only once the cards are dealt and the table is waiting. Anyone else, any other time, is ignored. */
  private go(player: Player): void {
    if (player !== this.dealer || this.phase !== 'playing' || this.game?.stage !== 'ready') return;
    this.game = startCountdown(this.game);
    this.startEndsAt = Date.now() + START_MS;
    this.startTimer = setTimeout(() => this.opened(), START_MS);
    this.startTimer.unref?.();
    this.changed();
  }

  /** "...NERTZ!": play opens, and everyone's next snapshot (one flush) shows the nertz tops. */
  private opened(): void {
    this.startTimer = null;
    if (this.phase !== 'playing' || !this.game) return;
    this.game = openPlay(this.game);
    // Play is open: the bots start looking at their cards now, like everyone else.
    for (const p of this.players) if (p.bot && this.game.players.some((g) => g.seat === p.seat)) this.wake(p, freshMemory());
    this.settle();
    this.changed();
  }

  private stopTimers(): void {
    for (const timer of [this.dealTimer, this.startTimer, this.graceTimer]) if (timer) clearTimeout(timer);
    this.dealTimer = this.startTimer = this.graceTimer = null;
  }

  private intent(player: Player, seq: number, intent: Extract<ClientMsg, { t: 'intent' }>['intent']): void {
    if (seq <= player.ack) return; // duplicate or out of order: already answered
    player.ack = seq;
    if (this.phase !== 'playing' || !this.game || (this.pausedBy && intent.k !== 'end')) return this.changed(player); // while paused, only the vote to end the round
    if (intent.k === 'flip' && this.flipMs > 0 && !player.bot) {
      const now = Date.now();
      if (now - (player.flipped ?? 0) < this.flipMs) return this.changed(player); // too soon after their last card: refused
      player.flipped = now;
    }
    const result = applyIntent(this.game, player.seat, intent);
    // A refused drop still empties the hand (see `refused`), which everyone sees and which can end the grace window.
    const next = result.ok ? result.state : refused(this.game, player.seat, intent);
    if (next === this.game) return this.changed(player); // rejected: only the sender needs to hear (its ack moved)
    this.game = next;
    this.settle();
    this.changed();
  }

  /**
   * A player reports where the card in their hand is. Purely for show: it is
   * forwarded to everyone else at the table with the seat stamped on, and
   * nothing is kept, checked against the rules or put in a snapshot. It is
   * forwarded only while the game says that player is holding that very card
   * (their `hold` came down the same socket just before), so nobody can make
   * a card fly that is not in their hand; and only DRAG_RATE times a second.
   */
  private dragged(player: Player, at: { t: 'drag' } & DragAt): void {
    if (this.phase !== 'playing' || this.pausedBy || this.game?.players.find((p) => p.seat === player.seat)?.holding !== at.id) return;
    const now = Date.now();
    const drags = (player.drags ??= { left: DRAG_BURST, at: now });
    drags.left = Math.min(DRAG_BURST, drags.left + ((now - drags.at) / 1000) * DRAG_RATE);
    drags.at = now;
    if (drags.left < 1) return;
    drags.left--;
    const msg: ServerMsg = { t: 'drag', seat: player.seat, id: at.id, w: at.w, h: at.h, p: at.p };
    for (const p of this.players) if (p !== player) p.conn?.send(msg);
  }

  /**
   * After anything that can end the round or complete an "everyone is stuck"
   * vote. Once Nertz is called the round waits (at most GRACE_MS) for the
   * players the engine left in grace, then is scored.
   */
  private settle(): void {
    if (this.phase !== 'playing' || !this.game) return;
    this.game = resolveEndVote(resolveStuck(this.game, this.connectedSeats()), this.players.filter((p) => p.conn && !p.bot).map((p) => p.seat));
    // A round ended without a call (a jammed table, or everyone voted to end it) ends at once: nobody is in grace.
    if (this.game.nertzCalledBy === null && !this.game.ended) return;
    if (!this.game.ended && !isOver(this.game)) {
      if (this.graceTimer) return;
      this.graceEndsAt = Date.now() + GRACE_MS;
      this.graceTimer = setTimeout(() => this.graceExpired(), GRACE_MS);
      this.graceTimer.unref?.();
      return;
    }
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    const scores = scoreRound(this.game).map((s) => {
      const p = this.players.find((p) => p.seat === s.seat);
      if (p) p.score += s.delta;
      return { ...s, name: p?.name ?? '', total: p?.score ?? s.delta };
    });
    this.lastRound = { calledBy: this.game.nertzCalledBy, scores, ...(this.game.ended ? { ended: this.game.ended } : {}) };
    this.phase = 'results';
    this.pausedBy = null;
    this.stopBots();
  }

  /**
   * Anyone dealt into the round may pause it while it is being played (not once Nertz is called). Cards in hand go
   * back, and the bots stop. The one who paused it carries on, or the dealer, or anyone once the one who paused is away.
   */
  private pause(player: Player, on: boolean): void {
    if (this.phase !== 'playing' || !this.game || !this.game.players.some((p) => p.seat === player.seat)) return;
    if (on) {
      if (this.pausedBy || this.game.stage !== 'play' || this.game.nertzCalledBy !== null || this.game.ended) return;
      this.pausedBy = player;
      for (const p of this.players) this.letGo(p);
      this.stopBots();
    } else {
      const by = this.pausedBy;
      if (!by || (player !== by && player !== this.dealer && by.conn)) return;
      this.pausedBy = null;
      for (const p of this.players) if (p.bot && this.game.players.some((g) => g.seat === p.seat)) this.wake(p);
    }
    this.changed();
  }

  private graceExpired(): void {
    this.graceTimer = null;
    if (this.phase !== 'playing' || !this.game) return;
    this.game = expireGrace(this.game);
    this.settle();
    this.changed();
  }

  /** The player's connection is gone: a card in their hand is put back, which also cuts them off if they were in grace. */
  private letGo(player: Player): void {
    if (this.phase !== 'playing' || !this.game) return;
    const result = applyIntent(this.game, player.seat, { k: 'release' });
    if (result.ok) this.game = result.state;
  }

  private drop(conn: Conn, leaving: boolean): void {
    const player = this.conns.get(conn);
    if (!player) return;
    this.conns.delete(conn);
    player.conn = null;
    if (leaving && this.phase === 'lobby') {
      this.players = this.players.filter((p) => p !== player);
      if (this.host === player) this.host = this.players.find((p) => p.conn && !p.bot) ?? this.players.find((p) => !p.bot) ?? null;
    } else if (leaving) {
      player.left = true; // their cards are on the table; the seat is freed when the next round is dealt
    }
    this.letGo(player);
    this.social.left(player, this.players);
    this.settle(); // the remaining connected players may now all be stuck
    this.changed();
  }

  // ------------------------------------------------------------ bots

  /** The lowest free seat, or null when the table is full. */
  private freeSeat(): number | null {
    // Someone who pressed Leave on the score sheet no longer counts: their seat is given away if it is the last one.
    if (this.players.filter((p) => !p.left).length >= MAX_PLAYERS) return null;
    const taken = (seat: number, by: Player[]) => by.some((p) => p.seat === seat);
    let seat = 0;
    while (taken(seat, this.players)) seat++;
    if (seat >= MAX_PLAYERS) {
      seat = 0;
      while (taken(seat, this.players.filter((p) => !p.left))) seat++;
      this.players = this.players.filter((p) => p.seat !== seat); // the leaver's line on the score sheet stays (`lastRound`)
    }
    return seat;
  }

  private addBot(by: Player, level: BotLevel): void {
    if (by !== this.dealer || this.phase === 'playing') return;
    const seat = this.freeSeat();
    if (seat === null) return;
    const name = BOT_NAMES.find((n) => !this.players.some((p) => p.name === n)) ?? 'Bot';
    // The token contains a character no client token may: nobody can join into a bot's seat.
    this.players.push({ token: `bot:${seat}`, name, seat, score: 0, conn: BOT_CONN, ack: -1, dirty: false, left: false, bot: { level, memory: freshMemory(), timer: null, pending: null } });
    this.players.sort((a, b) => a.seat - b.seat);
    this.changed();
  }

  private removeBot(by: Player, seat: number): void {
    const player = this.players.find((p) => p.seat === seat);
    if (by !== this.dealer || this.phase === 'playing' || !player?.bot) return;
    if (player.bot.timer) clearTimeout(player.bot.timer);
    this.players = this.players.filter((p) => p !== player); // its line on the score sheet stays (`lastRound`)
    this.changed();
  }

  /**
   * Schedules the bot's next look, a human-ish pause from now: its level's mean delay, half to one and a half times.
   * In the middle of dealing a group (`dealing`), the next card instead follows at the same quick step for everyone.
   */
  private wake(player: Player, memory?: BotMemory, dealing = false): void {
    const bot = player.bot!;
    if (memory) {
      bot.memory = memory;
      bot.pending = null;
    }
    if (bot.timer) clearTimeout(bot.timer);
    const think = BOTS[bot.level].delayMs * (0.5 + this.rng());
    bot.timer = setTimeout(() => this.look(player), dealing ? DEAL_STEP_MS : think);
    bot.timer.unref?.();
  }

  /**
   * One look, one action, a look late. At each look the bot first does what it
   * noticed at its PREVIOUS look, then looks again: so nothing it does is a
   * reaction faster than one pause, as with a person who has to see a card,
   * then move it. It decides from the view a person in its seat would be sent,
   * and its intent goes through `intent` like anyone's. If the table has moved
   * on meanwhile and the intent is refused (someone got there first), the bot
   * keeps its old memory and simply looks again.
   */
  private look(player: Player): void {
    const bot = player.bot!;
    bot.timer = null;
    if (this.phase !== 'playing' || !this.game) return;
    let midGroup = false;
    if (bot.pending) {
      const before = this.game;
      const { intent, memory } = bot.pending;
      bot.pending = null;
      this.intent(player, player.ack + 1, intent);
      if (this.game !== before) {
        bot.memory = memory;
        // It dealt a card off the stock and the group isn't finished: the rest of it comes at the common deal speed.
        midGroup = intent.k === 'flip' && (this.game.players.find((p) => p.seat === player.seat)?.dealt ?? 0) > 0;
      }
    }
    if (this.phase !== 'playing' || !this.game) return;
    bot.pending = chooseIntent(viewFor(this.game, player.seat), player.seat, bot.memory, this.rng, BOTS[bot.level].observance);
    this.wake(player, undefined, midGroup && bot.pending?.intent.k === 'flip');
  }

  private stopBots(): void {
    for (const p of this.players) {
      if (p.bot?.timer) clearTimeout(p.bot.timer);
      if (p.bot) p.bot.timer = null;
    }
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
        ending: this.phase === 'playing' && !!game?.players.find((g) => g.seat === p.seat)?.ending,
        bot: p.bot?.level,
      })),
      settings: this.settings,
      game,
      graceMs: this.graceTimer ? Math.max(0, this.graceEndsAt - Date.now()) : null,
      dealMs: this.dealTimer ? Math.max(0, this.dealEndsAt - Date.now()) : null,
      startMs: this.startTimer ? Math.max(0, this.startEndsAt - Date.now()) : null,
      paused: this.pausedBy ? { by: this.pausedBy.seat } : null,
      lastRound: this.lastRound,
    };
  }
}
