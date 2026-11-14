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
import { ANY_BACK, backNamed, backPool, deckNamed, DEAL_MS, DRAG_BURST, DRAG_RATE, GRACE_MS, MAX_PLAYERS, MAX_WATCHERS, MIN_PLAYERS, START_MS, type Back, type ClientMsg, type Deck, type DragAt, type ServerMsg } from '../shared/protocol';
import type { BotLevel, GameState, Intent, Phase, RoomView, RoundResult } from '../shared/types';
import { botAt, chooseIntent, DEAL_STEP_MS, freshMemory, type BotMemory } from './bot';
import { FLIGHT_MS, FLIGHT_STEP_MS, flightFrames } from '../shared/flight';
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
  /** How many rounds their score is the sum of: those they were dealt into. */
  rounds?: number;
  /** The card faces this player chose; everyone sees their cards drawn so. */
  deck?: Deck;
  back?: Back;
  night?: boolean;
  /** Their backs without the white edge. */
  bare?: boolean;
  /** Their back is drawn from this lot (`backPool`: 'all', or a kind of back) once for the table: at the first deal after it was chosen. `drew`: that has been done. */
  lot?: string;
  drew?: boolean;
  /** What is left of this player's allowance of card-position reports (`drag`), and when it was last topped up. */
  drags?: { left: number; at: number };
  /** When this player last dealt a card off their stock: dealing is paced by the server, not by how fast a client can send. */
  flipped?: number;
  /** Said they are ready for Start, for the round now dealt. */
  ready?: boolean;
  /** Stood up to watch: not to be given a seat until they ask for one. */
  standing?: boolean;
  /** When they began to wait for a seat (a count, not a clock): seats go to those watching in this order, whatever their numbers in the queue. */
  queued?: number;
  /** Sent away by whoever deals while their cards were in a round: gone for good when it is over (and not to come back into them meanwhile). */
  kicked?: boolean;
  /** Set for a bot. A bot is a player like any other, except that its `conn` is `BOT_CONN` and it never hosts. */
  bot?: { level: BotLevel; memory: BotMemory; timer: ReturnType<typeof setTimeout> | null; pending: { intent: Intent; memory: BotMemory } | null };
}

/** Without a seat at the table (it was full when they came): watching, in the queue for one. */
const watching = (p: { seat: number }): boolean => p.seat >= MAX_PLAYERS;

/** What a bot has for a connection: it counts as connected and is told nothing (it looks for itself, on its timer). */
const BOT_CONN: Conn = { send: () => {}, close: () => {} };
const BOT_NAMES = ['Bot Ada', 'Bot Bix', 'Bot Cleo', 'Bot Dot', 'Bot Eli', 'Bot Fay', 'Bot Gus', 'Bot Hal', 'Bot Ivy', 'Bot Jem'];

export interface RoomOptions {
  rng?: Rng;
  /** How to defer the coalesced flush; defaults to once per event-loop turn. */
  schedule?: (flush: () => void) => void;
  /** The least time between two cards a person deals off their stock (ms). 0, the default here, is no limit. */
  flipMs?: number;
}

/** How long a bot takes to change its mind when the move it had settled on is no longer there, ms (about: 0.6 to 1.4 times this). */
const RETHINK_MS = 500;
/** How long a bot takes to react where there is nothing to decide (its finished pile to the tray; calling Nertz): the same for every level. */
export const BOT_REACT_MS = 300;

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
  /** This round's snipes (see `sniped`): who, whom, and with which card. */
  private snipes: { by: number; of: number; card: string }[] = [];
  /** The last number given out to someone who began to wait for a seat (`Player.queued`). */
  private queue = 0;

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
  /** The round's clock: what it had run up before it was last stopped, and since when it is running now (ms epoch; null while it is not). */
  private played: number | null = null;
  private playingSince: number | null = null;
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
    this.social.isWatching = watching;
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
    // Someone whose window is gone (a tab closed, a phone that threw the page away) comes back as a stranger with the
    // name they had: they are given the seat that name left empty, with its score and its cards, not a second one.
    if (!player) {
      player = this.players.find((p) => !p.conn && !p.bot && !p.kicked && p.name === name);
      if (player) player.token = token;
    }
    if (!player) {
      // One rule for whoever arrives: while a round is being played they watch it (`watching`: no seat yet, a place in
      // the queue), and seats are given out when it is over, first come first, as far as there are any. With no round
      // on (the lobby, the score sheet, or cards dealt that nobody has played yet) there is nothing to wait for: they
      // sit down at once if a seat is free, and watch only if the table is full.
      const seat = (this.roundOn ? null : this.freeSeat()) ?? this.queuePlace();
      if (seat === null) return 'That room is full.';
      player = { token, name, seat, score: 0, conn: null, ack: -1, dirty: false, left: false };
      if (watching(player)) player.queued = ++this.queue;
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
    if (!watching(player)) this.host ??= player;
    this.social.joined(player, this.players);
    if (watching(player)) this.seatWatchers(); // (someone watching who was away and is back: a seat that came free meanwhile was kept from them)
    // Before the dealer has said Start nothing has been played: whoever arrives then is dealt in. (And whoever sat down
    // while there were not two here to deal to: with this one back, there are.)
    const game = this.game;
    if (this.phase === 'playing' && game && (game.stage === 'dealing' || game.stage === 'ready') && this.present >= MIN_PLAYERS && this.players.some((p) => p.conn && !watching(p) && !game.players.some((g) => g.seat === p.seat))) this.dealOut();
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
      case 'ready': {
        const stage = this.phase === 'playing' ? this.game?.stage : undefined;
        if ((stage !== 'dealing' && stage !== 'ready') || !this.game!.players.some((g) => g.seat === player.seat) || !!player.ready === msg.on) return;
        player.ready = msg.on;
        return this.changed();
      }
      case 'settings':
        return this.configure(player, msg.patch);
      case 'intent':
        return this.intent(player, msg.seq, msg.intent);
      case 'drag':
        return this.dragged(player, msg);
      case 'leave':
        return this.drop(conn, true);
      case 'sniped':
        return this.sniped(player, msg.slot);
      case 'stand': {
        // Up from the table to watch, or back in the queue for a seat: oneself, or whoever deals for someone else.
        const who = msg.seat === undefined ? player : this.players.find((p) => p.seat === msg.seat);
        if (!who || who.bot || (who !== player && player !== this.dealer) || !!who.standing === msg.on) return;
        if (msg.on) {
          // (Not out of a round they hold cards in: those would be left lying. When it is over.)
          if (this.phase === 'playing' && this.game?.players.some((g) => g.seat === who.seat)) return;
          if (!watching(who)) {
            const place = this.queuePlace();
            if (place === null) return;
            this.offSheet(who.seat, true); // their line of the last round stays, but is theirs, not the seat's: whoever has the seat next is not shown as them
            this.moveTo(who, place);
          }
          who.standing = true;
        } else {
          delete who.standing;
          who.queued = ++this.queue; // behind whoever is waiting already
        }
        this.seatWatchers(); // the seat they left is someone's who was waiting; or, sitting down again, one is theirs if there is one
        return this.changed();
      }
      case 'kick': {
        // Whoever deals may send a person away from the table, at any time: as if they had left, whether they are here or away.
        const out = this.players.find((p) => p.seat === msg.seat);
        if (player !== this.dealer || !out || out.bot || out === player) return;
        const theirs = out.conn;
        if (theirs) {
          theirs.send({ t: 'removed' }); // (so that their window goes home and does not come straight back)
          this.conns.delete(theirs);
          out.conn = null;
        }
        this.offSheet(out.seat);
        this.depart(out, true);
        // Sent away is gone: not left on the list as someone away who comes in at the next deal. (Unless a round is on
        // with their cards in it: then at its end, `sendOff`, and until then there is no coming back into them.)
        if (this.players.includes(out)) {
          if (this.phase === 'playing' && this.game?.players.some((g) => g.seat === out.seat)) {
            out.kicked = true;
            out.token = `kicked:${out.token}`; // (a character no client token may have)
          } else {
            this.players = this.players.filter((p) => p !== out);
            this.seatWatchers();
          }
        }
        this.mendHost();
        this.changed();
        theirs?.close();
        return;
      }
      case 'addBot':
        return this.addBot(player, msg.level);
      case 'removeBot':
        return this.removeBot(player, msg.seat);
      case 'reset':
        return this.reset(player);
      case 'redeal':
        // Whoever deals may deal the round over, at any point of it: nothing of it is scored, and everyone who is here now is in it.
        if (player !== this.dealer || this.phase !== 'playing' || !this.game) return;
        {
          // Enough to deal to? Those at the table who are here, and those waiting for whom it has a seat. (Counted before anyone is moved: a deal refused changes nothing.)
          const open = MAX_PLAYERS - this.players.filter((p) => !watching(p) && !p.kicked).length;
          const waiting = this.players.filter((p) => watching(p) && !p.standing && p.conn).length;
          if (this.present + Math.min(open, waiting) < MIN_PLAYERS) return;
        }
        this.sendOff(); // (their cards are gone with the round)
        this.seatWatchers(true); // (whoever was watching is here now, too)
        this.stopBots();
        for (const p of this.players) if (p.bot) p.bot.pending = null; // what a bot was about to do was about cards that are gone
        return this.dealOut();
      case 'debugBotOut':
        return this.debugBotOut(player);
      case 'botName': {
        // Whoever deals names the bots: any time, like their backs. (Not a name someone at the table has.)
        const bot = this.players.find((p) => p.seat === msg.seat);
        if (player !== this.dealer || !bot?.bot || this.players.some((p) => p !== bot && p.name === msg.name)) return;
        bot.name = msg.name;
        return this.changed();
      }
      case 'botBack': {
        // Whoever deals dresses the bots: any time, since it changes nothing but how their cards look.
        const bot = this.players.find((p) => p.seat === msg.seat);
        if (player !== this.dealer || !bot?.bot) return;
        if (msg.back) bot.back = msg.back;
        if (msg.lot !== undefined) this.setLot(bot, msg.lot);
        return this.changed();
      }
      case 'pause':
        return this.pause(player, msg.on);
      case 'seat':
        // A seat is a colour, and a place round the table. Only before the first deal (scores and the last round go by seat), and only an empty one.
        // (Not for someone watching: a seat is theirs by the queue, or by sitting down again.)
        if (this.phase !== 'lobby' || watching(player) || this.players.some((p) => p.seat === msg.seat)) return;
        {
          const from = player.seat;
          player.seat = msg.seat;
          this.players.sort((a, b) => a.seat - b.seat);
          this.social.moved(player, from, this.players); // chat and voice go by seat
          return this.changed();
        }
      case 'deck': {
        // A back drawn by lot is the table's to keep: the back sent along (their own choice, for when there is no lot) is not taken in its place.
        const lot = msg.lot === undefined ? (player.lot ?? null) : msg.lot;
        const back = lot !== null && lot === player.lot && player.drew ? player.back : (msg.back ?? player.back);
        if (player.deck === msg.deck && player.back === back && !!player.night === (msg.night ?? !!player.night) && !!player.bare === (msg.bare ?? !!player.bare) && (player.lot ?? null) === lot) return;
        player.deck = msg.deck;
        player.back = back;
        player.night = msg.night ?? player.night;
        player.bare = msg.bare ?? player.bare;
        this.setLot(player, lot);
        return this.changed();
      }
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
    return this.host?.conn ? this.host : (this.players.find((p) => p.conn && !p.bot && !watching(p)) ?? this.host);
  }

  /** Table settings belong to whoever may deal, and stand still while a round is on. Anyone else is ignored. */
  private configure(player: Player, patch: Partial<TableSettings>): void {
    if (player !== this.dealer || this.phase === 'playing') return;
    this.settings = { ...this.settings, ...patch };
    this.changed();
  }

  private start(player: Player): void {
    // Only people who are here get cards. Someone away keeps their seat and score and sits the round out.
    const dealt = this.players.filter((p) => p.conn && !watching(p));
    if (player !== this.dealer || this.phase === 'playing' || dealt.length < MIN_PLAYERS) return;
    this.players = this.players.filter((p) => !p.left);
    this.seatWatchers(); // whoever left has freed a seat: the first in the queue has it, and is dealt in
    if (!this.host || !this.players.includes(this.host)) this.host = player;
    this.round++;
    this.dealOut();
  }

  /**
   * The cards of the round are dealt to everyone who is here. Also a second time, if someone sits down (or comes
   * back) after the deal but before the dealer has said Start: nothing has been played, so the round is simply
   * dealt again with them in it.
   */
  private dealOut(): void {
    const dealt = this.players.filter((p) => p.conn && !watching(p));
    this.snipes = [];
    for (const p of this.players) delete p.ready;
    for (const p of dealt) if (p.lot && !p.drew) this.drawBack(p); // a back by lot is drawn now: once, and kept for every round at this table
    this.game = deal(
      dealt.map((p) => p.seat),
      this.rng,
      this.settings,
    );
    this.phase = 'playing';
    this.pausedBy = null;
    this.played = 0; // the clock starts on the word NERTZ!
    this.playingSince = null;
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
    this.played = 0;
    this.playingSince = Date.now();
    // Play is open: the bots start looking at their cards now, like everyone else.
    for (const p of this.players) if (p.bot && this.game.players.some((g) => g.seat === p.seat)) this.wake(p, freshMemory());
    this.settle();
    this.changed();
  }

  /**
   * `victim` was beaten to the pile at `slot`: its top card is someone else's, and they have the very same card (suit
   * and rank) showing on one of their own piles, with nowhere to put it now. Counted once for each such card; shown
   * with the round's scores. (Said by the victim's window, or seen here when their move arrives too late.)
   */
  private sniped(victim: Player, slot: number): void {
    if (this.phase !== 'playing' || !this.game) return;
    const top = this.game.slots[slot]?.at(-1);
    const hand = this.game.players.find((g) => g.seat === victim.seat);
    if (!top || !hand || top.owner === victim.seat || top.rank === 1) return; // (an Ace beaten to a place has others to go to)
    const showing = [hand.nertz.at(-1), hand.waste.at(-1), ...hand.work.map((pile) => pile.at(-1))];
    if (!showing.some((c) => c && 'suit' in c && c.suit === top.suit && c.rank === top.rank)) return;
    if (this.snipes.some((s) => s.of === victim.seat && s.card === top.id)) return;
    this.snipes.push({ by: top.owner, of: victim.seat, card: top.id });
    const by = this.players.find((p) => p.seat === top.owner);
    by?.conn?.send({ t: 'sniper', of: victim.seat });
    if (by) this.social.sniped(this.players, by, victim); // and everyone reads of it where the chat is
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
    if (!result.ok && intent.k === 'move' && intent.to.k === 'slot') this.sniped(player, intent.to.i); // (a race lost on the way here)
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
      if (p) p.rounds = (p.rounds ?? 0) + 1;
      const deck = p?.deck && deckNamed(p.deck, p.night);
      const back = p && backNamed(p.back, p.bare);
      return { ...s, name: p?.name ?? '', total: p?.score ?? s.delta, rounds: p?.rounds ?? 1, ...(deck ? { deck } : {}), ...(back ? { back } : {}) };
    });
    const pairs = new Map<string, { by: number; of: number; n: number }>();
    for (const s of this.snipes) {
      const pair = pairs.get(`${s.by}>${s.of}`) ?? { by: s.by, of: s.of, n: 0 };
      pair.n++;
      pairs.set(`${s.by}>${s.of}`, pair);
    }
    const snipes = [...pairs.values()].sort((a, b) => b.n - a.n || a.by - b.by || a.of - b.of);
    this.lastRound = { calledBy: this.game.nertzCalledBy, scores, ...(this.game.ended ? { ended: this.game.ended } : {}), ...(snipes.length ? { snipes } : {}) };
    this.phase = 'results';
    this.stopClock();
    this.pausedBy = null;
    this.stopBots();
    this.sendOff();
    this.seatWatchers(); // the round is over: whoever watched it sits down, as far as there are seats
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
      this.stopClock();
      for (const p of this.players) this.letGo(p);
      this.stopBots();
    } else {
      const by = this.pausedBy;
      if (!by || (player !== by && player !== this.dealer && by.conn)) return;
      this.pausedBy = null;
      this.playingSince = Date.now();
      for (const p of this.players) if (p.bot && this.game.players.some((g) => g.seat === p.seat)) this.wake(p);
    }
    this.changed();
  }

  /** The round's clock stops (a pause, or the end of the round), keeping what it has run up. */
  private stopClock(): void {
    if (this.playingSince !== null) this.played = (this.played ?? 0) + Date.now() - this.playingSince;
    this.playingSince = null;
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
    this.depart(player, leaving);
  }

  /** A player has no connection any more: gone for now, or (`leaving`) for good. */
  private depart(player: Player, leaving: boolean): void {
    // (Someone only watching the round, having sat down in the middle of it, has no cards on the table to stay for.)
    // (Nor has someone who never had a seat: they are simply gone, whatever the table is doing.)
    if (leaving && (watching(player) || this.phase === 'lobby' || (this.phase === 'playing' && !this.game?.players.some((g) => g.seat === player.seat)))) {
      this.players = this.players.filter((p) => p !== player);
      if (this.host === player) this.host = this.heir();
      this.seatWatchers(); // a seat is free: the first in the queue has it
    } else if (leaving) {
      player.left = true; // their cards are on the table; the seat is freed when the next round is dealt
      this.seatWatchers(); // (between rounds it is free at once, for whoever is first in the queue)
    }
    this.letGo(player);
    this.social.left(player, this.players);
    this.settle(); // the remaining connected players may now all be stuck
    this.changed();
  }

  // ------------------------------------------------------------ bots

  /** A place in the queue of those watching: the first seat number past the table's that nobody has, or null when the queue is full too. */
  private queuePlace(): number | null {
    for (let seat = MAX_PLAYERS; seat < MAX_PLAYERS + MAX_WATCHERS; seat++) if (!this.players.some((p) => p.seat === seat)) return seat;
    // Full: but someone watching whose window is long gone holds a place for nobody. The one away of those gives it up.
    const gone = this.players.find((p) => watching(p) && !p.conn && p !== this.host);
    if (!gone) return null;
    this.players = this.players.filter((p) => p !== gone);
    return gone.seat;
  }

  /** Who the table falls to when its host is gone: someone with a seat, a person, and one who is here if there is one. */
  private heir(): Player | null {
    return this.players.find((p) => p.conn && !p.bot && !watching(p)) ?? this.players.find((p) => !p.bot && !watching(p)) ?? null;
  }

  /**
   * Whoever sat in `seat` when the last round was played has it no longer. Their line of that round is taken off the
   * score sheet (sent away); or (`vacant`: they stood up, or left) it stays on it, marked as no longer the seat's, so
   * that whoever sits there next is not taken for them.
   */
  private offSheet(seat: number, vacant = false): void {
    if (this.lastRound) this.lastRound = { ...this.lastRound, scores: this.lastRound.scores.map((s) => (s.seat === seat && !s.gone && !s.vacant ? { ...s, ...(vacant ? { vacant: true } : { gone: true }) } : s)) };
  }

  /** Those at the table who are here: who a deal would give cards to. */
  private get present(): number {
    return this.players.filter((p) => p.conn && !watching(p)).length;
  }

  /** The round is over (or dealt over): whoever was sent away while their cards were in it is gone now, and off the score sheet. */
  private sendOff(): void {
    for (const out of this.players.filter((p) => p.kicked)) this.offSheet(out.seat);
    this.players = this.players.filter((p) => !p.kicked);
    this.mendHost();
  }

  /** The host is always someone at the table: if they are not on the list any more, the table falls to its heir. */
  private mendHost(): void {
    if (this.host && !this.players.includes(this.host)) this.host = this.heir();
  }

  /** Seats at the table that have come free go to those watching, first come first: each takes the seat, and with it a colour; what they said and their voice go with them. */
  private seatWatchers(redealing = false): void {
    // (Not while a round is being played: whoever watches it sits down when it is over. Nor those who stood up by choice.)
    if (this.roundOn && !redealing) return; // (dealt over: the round is as good as not begun)
    // (Nor someone whose window is gone: their place in the queue is kept, and a seat is theirs when they are back.)
    const waiting = this.players.filter((q) => watching(q) && !q.standing && q.conn).sort((a, b) => (a.queued ?? 0) - (b.queued ?? 0));
    let seated = false;
    for (const p of waiting) {
      // (The seat they stood up from, if nobody has it: their colour, and their line of the last round, are theirs again.)
      const own = this.lastRound?.scores.find((l) => l.vacant && l.name === p.name && !this.players.some((q) => q.seat === l.seat))?.seat;
      const seat = own ?? this.freeSeat();
      if (seat === null) break;
      this.moveTo(p, seat);
      delete p.queued;
      this.host ??= p;
      seated = true;
    }
    // Cards dealt that nobody has played yet: whoever sits down then is dealt in, like someone who arrives then.
    if (seated && !redealing && this.phase === 'playing' && this.present >= MIN_PLAYERS) this.dealOut();
  }

  /** Is a round being played (the count, and play)? Not: the lobby, the score sheet, or cards dealt that nobody has played yet. */
  private get roundOn(): boolean {
    const stage = this.phase === 'playing' ? this.game?.stage : undefined;
    return stage === 'countdown' || stage === 'play';
  }

  /** `p` takes another seat (or a place in the queue): what they said goes with them, and their voice is put out to join again from there. */
  private moveTo(p: Player, seat: number): void {
    const from = p.seat;
    p.seat = seat;
    this.players.sort((a, b) => a.seat - b.seat);
    this.social.moved(p, from, this.players);
    // (Back in the seat they stood up from: their line of the last round is the seat's again.)
    if (this.lastRound?.scores.some((l) => l.seat === seat && l.vacant && l.name === p.name)) this.lastRound = { ...this.lastRound, scores: this.lastRound.scores.map(({ vacant, ...l }) => (l.seat === seat && vacant ? l : { ...l, ...(vacant ? { vacant } : {}) })) };
  }

  /** What a bot is at this table just now: its level, at the number of players dealt in. */
  private botNow(bot: NonNullable<Player['bot']>): { delayMs: number; observance: number } {
    return botAt(bot.level, this.game?.players.length ?? 2);
  }

  /** The lowest free seat, or null when the table is full. */
  private freeSeat(): number | null {
    // Someone who pressed Leave on the score sheet no longer counts: their seat is given away if it is the last one.
    if (this.players.filter((p) => !p.left && !watching(p)).length >= MAX_PLAYERS) return null;
    const taken = (seat: number, by: Player[]) => by.some((p) => p.seat === seat);
    let seat = 0;
    while (taken(seat, this.players)) seat++;
    if (seat >= MAX_PLAYERS) {
      // (Not while their cards are in play: whoever sits in a seat plays its cards.)
      if (this.phase === 'playing') return null;
      seat = 0;
      while (taken(seat, this.players.filter((p) => !p.left))) seat++;
      this.players = this.players.filter((p) => p.seat !== seat); // the leaver's line on the score sheet stays (`lastRound`): as theirs, not the seat's
      this.offSheet(seat, true);
      this.mendHost();
    }
    return seat;
  }

  private addBot(by: Player, level: BotLevel): void {
    if (by !== this.dealer || this.phase === 'playing') return;
    const seat = this.freeSeat();
    if (seat === null) return;
    const name = BOT_NAMES.find((n) => !this.players.some((p) => p.name === n)) ?? 'Bot';
    // The token contains a character no client token may: nobody can join into a bot's seat. A bot has a deck like anyone: the plain one.
    this.players.push({ token: `bot:${seat}`, name, seat, deck: 'modern', score: 0, conn: BOT_CONN, ack: -1, dirty: false, left: false, bot: { level, memory: freshMemory(), timer: null, pending: null } });
    this.players.sort((a, b) => a.seat - b.seat);
    this.changed();
  }

  /**
   * Starts the table over, for whoever deals and only between rounds: every score back to nothing, no round played,
   * no last round to show, and the table in its lobby again (where colours can be changed) with everyone who is still
   * sitting at it. Its rules, and everyone's cards and seats, stay as they are.
   */
  private reset(by: Player): void {
    if (by !== this.dealer || this.phase !== 'results') return;
    this.players = this.players.filter((p) => !p.left);
    this.mendHost();
    for (const p of this.players) {
      p.score = 0;
      delete p.rounds;
      if (p.lot) p.drew = false; // a table started over draws its lots over
    }
    this.round = 0;
    this.lastRound = null;
    this.game = null;
    this.phase = 'lobby';
    this.seatWatchers();
    this.changed();
  }

  /** A player's back is to be drawn by lot (or, with null, no longer): once, at the next deal, and kept at this table from then on. If a round is on, it is drawn at once. */
  private setLot(player: Player, lot: string | null): void {
    if (lot === null) {
      delete player.lot;
      delete player.drew;
      return;
    }
    if (player.lot === lot) return;
    player.lot = lot;
    player.drew = false; // a lot chosen anew is drawn anew: at the next deal, or now if a round is on
    if (this.phase === 'playing') this.drawBack(player);
  }

  /** Draws a back for a player from their lot: not the one they had, if there is another to be had. */
  private drawBack(player: Player): void {
    const pool = backPool(player.lot!);
    const fresh = pool.length > 1 ? pool.filter((b) => b !== player.back) : pool;
    player.back = fresh[Math.floor(this.rng() * fresh.length)]!;
    player.drew = true;
  }

  private removeBot(by: Player, seat: number): void {
    const player = this.players.find((p) => p.seat === seat);
    if (by !== this.dealer || this.phase === 'playing' || !player?.bot) return;
    if (player.bot.timer) clearTimeout(player.bot.timer);
    this.players = this.players.filter((p) => p !== player);
    // Its line of the last round stays for the cards it left on the table, but is taken off the score sheet: a bot sent away is gone.
    this.offSheet(seat);
    this.seatWatchers(); // its seat is free: the first in the queue has it
    this.changed();
  }

  /**
   * Schedules the bot's next look, a human-ish pause from now: its level's mean delay, half to one and a half times.
   * In the middle of dealing a group (`dealing`), the next card instead follows at the same quick step for everyone.
   */
  private wake(player: Player, memory?: BotMemory, dealing = false, spent = 0): void {
    const bot = player.bot!;
    if (memory) {
      bot.memory = memory;
      bot.pending = null;
    }
    if (bot.timer) clearTimeout(bot.timer);
    const think = this.botNow(bot).delayMs * (0.5 + this.rng());
    // What needs no thinking takes no thinking time, whatever the bot's level or the size of the table: a pile it has
    // just finished is carried to the tray (a moment to react, and the time a hand takes to carry it there), and
    // Nertz is called as soon as there is nothing left to put down (a moment to react).
    const k = bot.pending?.intent.k;
    const react = BOT_REACT_MS * (0.75 + 0.5 * this.rng());
    const reflex = k === 'clear' ? react + FLIGHT_MS.centre : k === 'nertz' ? react : null;
    bot.timer = setTimeout(() => this.look(player), dealing ? DEAL_STEP_MS : (reflex ?? Math.max(FLIGHT_STEP_MS, think - spent)));
    bot.timer.unref?.();
  }

  /**
   * One look, one action, a look late. At each look the bot first does what it
   * noticed at its PREVIOUS look, then looks again: so nothing it does is a
   * reaction faster than one pause, as with a person who has to see a card,
   * then move it. It decides from the view a person in its seat would be sent,
   * and its intent goes through `intent` like anyone's. If the table has moved
   * on meanwhile and the intent is refused (someone got there first), the bot
   * keeps its old memory and simply looks again. A move is not made on the
   * spot: the bot picks the card up and carries it over (`fly`) first.
   */
  private look(player: Player): void {
    const bot = player.bot!;
    bot.timer = null;
    if (this.phase !== 'playing' || !this.game || this.pausedBy) return;
    let midGroup = false;
    if (bot.pending) {
      const before = this.game;
      const { intent, memory } = bot.pending;
      // The table moved on while it was making up its mind and the move it meant to make is gone (someone took the
      // pile): it does not go through the motions of a move it can see is lost. It thinks again, briefly.
      if (intent.k === 'move' && !applyIntent(before, player.seat, intent).ok) return this.rethink(player);
      if (intent.k === 'move' && flightFrames(before, player.seat, intent).length > 0) return this.fly(player);
      bot.pending = null;
      this.intent(player, player.ack + 1, intent);
      if (this.game !== before) {
        bot.memory = memory;
        // It dealt a card off the stock and the group isn't finished: the rest of it comes at the common deal speed.
        midGroup = intent.k === 'flip' && (this.game.players.find((p) => p.seat === player.seat)?.dealt ?? 0) > 0;
      }
    }
    this.decide(player, midGroup);
  }

  /** The bot looks the table over and picks its next action, done after a pause (less `spent`: time already gone on a move). */
  private decide(player: Player, midGroup = false, spent = 0): void {
    const bot = player.bot!;
    if (this.phase !== 'playing' || !this.game) return;
    bot.pending = chooseIntent(viewFor(this.game, player.seat), player.seat, bot.memory, this.rng, this.botNow(bot).observance);
    this.wake(player, undefined, midGroup && bot.pending?.intent.k === 'flip', spent);
  }

  /**
   * The bot's pending move, carried out the way a person does it: it picks the card up (so it counts as held, for the
   * grace window and for anyone watching), its card is shown crossing the table (made-up drag reports, see
   * shared/flight.ts), and then it is put down. Someone may take the place meanwhile: then the drop is refused and the
   * card goes home, as anyone's would. A pause, or the end of the round, cuts the flight off; the move stays pending.
   */
  private fly(player: Player): void {
    const bot = player.bot!;
    const { intent, memory } = bot.pending!;
    if (intent.k !== 'move') return;
    const before = this.game!;
    this.intent(player, player.ack + 1, { k: 'hold', cardId: intent.cardId });
    if (this.game === before) {
      bot.pending = null; // it could not pick that card up any more
      return this.decide(player);
    }
    const frames = flightFrames(this.game!, player.seat, intent);
    let i = 0;
    const step = () => {
      bot.timer = null;
      const game = this.game;
      if (this.phase !== 'playing' || !game || this.pausedBy) return;
      if (game.players.find((p) => p.seat === player.seat)?.holding !== intent.cardId) {
        bot.pending = null; // taken out of its hand (the grace window closed): start afresh
        return this.decide(player);
      }
      const frame = frames[i++];
      if (frame) {
        const msg: ServerMsg = { t: 'drag', seat: player.seat, ...frame };
        for (const p of this.players) p.conn?.send(msg);
        bot.timer = setTimeout(step, FLIGHT_STEP_MS);
        bot.timer.unref?.();
        return;
      }
      bot.pending = null;
      const lands = applyIntent(game, player.seat, intent).ok; // (a refused drop changes the table too: the card goes home)
      this.intent(player, player.ack + 1, intent);
      if (lands) bot.memory = memory;
      this.decide(player, false, frames.length * FLIGHT_STEP_MS);
    };
    step();
  }

  /**
   * For trying things out (seeing and hearing a bot go out without playing a round through): never in production, and only for whoever deals.
   * The first bot in the round has its nertz pile put under its stock, drops whatever it was about to do, and calls.
   */
  private debugBotOut(by: Player): void {
    if (process.env.NODE_ENV === 'production' || by !== this.dealer || this.pausedBy || this.phase !== 'playing' || !this.game || this.game.stage !== 'play' || this.game.nertzCalledBy !== null) return;
    const bot = this.players.find((p) => p.bot && this.game!.players.some((g) => g.seat === p.seat));
    if (!bot?.bot) return;
    if (bot.bot.timer) clearTimeout(bot.bot.timer);
    bot.bot.timer = null;
    bot.bot.pending = null;
    this.game = { ...this.game, players: this.game.players.map((g) => (g.seat === bot.seat ? { ...g, holding: null, nertz: [], stock: [...g.nertz, ...g.stock] } : g)) };
    this.intent(bot, bot.ack + 1, { k: 'nertz' });
  }

  /** The bot's plan came to nothing before it acted on it: it picks another and acts on that after a short pause, not a whole one. */
  private rethink(player: Player): void {
    const bot = player.bot!;
    bot.pending = chooseIntent(viewFor(this.game!, player.seat), player.seat, bot.memory, this.rng, this.botNow(bot).observance);
    if (bot.timer) clearTimeout(bot.timer);
    bot.timer = setTimeout(() => this.look(player), RETHINK_MS * (0.6 + 0.8 * this.rng()));
    bot.timer.unref?.();
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
      // (Those at the table by seat; then those watching, in the order they will be seated, and last whoever watches by choice.)
      players: [...this.players.filter((p) => !watching(p)), ...this.players.filter(watching).sort((a, b) => Number(!!a.standing) - Number(!!b.standing) || (a.queued ?? 0) - (b.queued ?? 0))].map((p) => ({
        seat: p.seat,
        name: p.name,
        connected: p.conn !== null,
        score: p.score,
        rounds: p.rounds ?? 0,
        isHost: p === dealer,
        stuck: stuck(p.seat),
        ending: this.phase === 'playing' && !!game?.players.find((g) => g.seat === p.seat)?.ending,
        ...(this.phase === 'playing' && (game?.stage === 'dealing' || game?.stage === 'ready') && (p.bot || p.ready) && game.players.some((g) => g.seat === p.seat) ? { ready: true } : {}),
        bot: p.bot?.level,
        ...(watching(p) ? { watching: true } : {}),
        ...(p.standing ? { standing: true } : {}),
        deck: p.deck && deckNamed(p.deck, p.night),
        // (A back by lot is not known until a round is dealt: before the first, a card with a question mark.)
        back: p.lot && this.phase === 'lobby' ? ANY_BACK : backNamed(p.back, p.bare),
        ...(p.lot ? { lot: p.lot } : {}),
      })),
      settings: this.settings,
      game,
      graceMs: this.graceTimer ? Math.max(0, this.graceEndsAt - Date.now()) : null,
      dealMs: this.dealTimer ? Math.max(0, this.dealEndsAt - Date.now()) : null,
      startMs: this.startTimer ? Math.max(0, this.startEndsAt - Date.now()) : null,
      clock: this.played === null ? null : { ms: this.played + (this.playingSince === null ? 0 : Date.now() - this.playingSince), running: this.playingSince !== null },
      paused: this.pausedBy ? { by: this.pausedBy.seat } : null,
      lastRound: this.lastRound,
    };
  }
}
