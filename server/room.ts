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
import { applyIntent, calledBy, deal, expireGrace, finishDeal, inRound, isLive, openPlay, refused, resolveEndVote, resolveStuck, scoreRound, snipedBy, startCountdown, viewFor, type Rng } from '../shared/engine';
import { anotherBack, backPool, DEAL_MS, DRAG_BURST, DRAG_RATE, fewestSeats, freeSeats, GRACE_MS, MAX_PLAYERS, MAX_WATCHERS, MIN_PLAYERS, PLAIN_LOOK, START_MS, type Backs, type ClientMsg, type DragAt, type Look, type ServerMsg } from '../shared/protocol';
import type { BotLevel, GameState, Intent, Phase, RoomView, RoundResult, Seats, TableSummary } from '../shared/types';
import { botAt, chooseIntent, DEAL_STEP_MS, freshMemory, type BotMemory } from './bot';
import { FLIGHT_MS, FLIGHT_STEP_MS, flightFrames } from '../shared/flight';
import { DEFAULT_SETTINGS, type TableSettings } from '../shared/settings';
import type { Named } from '../shared/chat';
import { roundOver, Social } from './chat';
import { guard } from './guard';

/** A live client connection, as far as a room cares. */
export interface Conn {
  send(msg: ServerMsg): void;
  /** The server is done with this connection for good (`CLOSE_OVER`): `reason` is what the player is told. */
  close(reason: string): void;
}

/**
 * Someone in the room: a person, or a bot.
 *
 * WHO they are is `id`, for as long as the room stands. Everything about a person goes by it: who said what, who is
 * in voice, whose line of the score sheet, who hosts. What is about cards goes by seat (a hand, a card's owner).
 *
 * WHERE they are is exactly one of three things:
 *   at the table   `seat` is a number: dealt into every round that begins while they are here
 *   in the queue   `queued` is a number: waiting for a seat, first come first
 *   watching       neither: no seat, and not asking for one
 * It changes only in `fill` (queue to table), on `sit` (asking for a seat, giving it up), in `sendOff` and in `remove`.
 * Someone at the table takes one of its seats (`Room.seats`), unless they are `out`.
 *
 * Apart from that: here or away (`conn`); and up from their cards (`out`).
 */
interface Player {
  id: number;
  /** Secret chosen by the client; maps a reconnect back to who they are. Never sent to anyone. */
  token: string;
  name: string;
  seat: number | null;
  /** Their number in the queue for a seat (a count, not a clock: lower is earlier); null when they are not in it. Never set together with `seat`. */
  queued: number | null;
  /**
   * Up for good from their cards in the round being played: they stood up (or were stood up by whoever deals), left,
   * or were sent away. For the round it is all one: their cards lie where they are and are scored as they lie; they
   * play no more of it and have no say in its votes; and they hold the seat only for those cards, until it is over
   * (`sendOff`). What becomes of them then is what this says: whoever stood up is watching, whoever left is off the
   * list, and whoever was sent away is off the score sheet too. Only someone who stood up is still here meanwhile: the
   * other two are gone now (`gone`), and back by their token they are someone new. (With no cards in play none of this
   * waits: see `sit` and `gone`.)
   */
  out?: 'stood' | 'left' | 'kicked';
  /**
   * Standing up, for now, from their cards in the round being played: they said so themselves (`sit` off), and may take
   * it back until the round is over (`sit` on, or any move of theirs). Meanwhile they are as good as away: their cards
   * lie as they are and they have no say in its votes. When it is over (`sendOff`) they are watching.
   */
  standing?: true;
  score: number;
  conn: Conn | null;
  /** Highest intent seq processed from the current connection (-1 = none yet). */
  ack: number;
  /** Owes this player a snapshot at the next flush. */
  dirty: boolean;
  /** How many rounds their score is the sum of: those they were dealt into. */
  rounds?: number;
  /** How many of those rounds they ended by calling Nertz. */
  calls?: number;
  /** The faces and backs this player chose; everyone sees their cards drawn so. */
  look: Look;
  /** What is left of this player's allowance of card-position reports (`drag`), and when it was last topped up. */
  drags?: { left: number; at: number };
  /** When this player last dealt a card off their stock: dealing is paced by the server, not by how fast a client can send. */
  flipped?: number;
  /** Said they are ready for Start, for the round now dealt. */
  ready?: boolean;
  /** Set for a bot. A bot is a player like any other, except that its `conn` is `BOT_CONN` and it never hosts. */
  bot?: { level: BotLevel; memory: BotMemory; timer: ReturnType<typeof setTimeout> | null; pending: { intent: Intent; memory: BotMemory } | null };
}

/**
 * What `was` becomes when the player (or, for a bot, whoever deals) says `to`; `was` itself if that changes nothing.
 * A back drawn by lot is the table's to keep: the same lot said again keeps what was drawn from it.
 */
function rechosen(was: Backs, to: Backs): Backs {
  if (to.k === 'lot') return was.k === 'lot' && was.lot === to.lot ? was : { k: 'lot', lot: to.lot, drawn: null };
  return was.k === 'own' && was.back === to.back ? was : to;
}

type Seated = Player & { seat: number };
const seated = (p: Player): p is Seated => p.seat !== null;
/** Takes one of the table's seats: at it, and not up from their cards (`out`: whoever is holds their seat only for those). */
const taking = (p: Player): p is Seated => seated(p) && !p.out;
/** Gone from the room, but for cards of theirs that lie there: they left, or were sent away (see `out`). */
const gone = (p: Player): boolean => p.out === 'left' || p.out === 'kicked';
/** The seat to ask the engine about for `p`: the one whose cards they play, or one that no hand has (they have none, or are up from theirs). */
const at = (p: Player): number => (taking(p) ? p.seat : -1);
/** `p` as a line of the chat names them. */
const named = (p: Player): Named => ({ who: p.id, name: p.name });

/** What a bot has for a connection: it counts as connected and is told nothing (it looks for itself, on its timer). */
const BOT_CONN: Conn = { send: () => {}, close: () => {} };
const BOT_NAMES = ['Bot Ada', 'Bot Bix', 'Bot Cleo', 'Bot Dot', 'Bot Eli', 'Bot Fay', 'Bot Gus', 'Bot Hal', 'Bot Ivy', 'Bot Jem'];

export interface RoomOptions {
  rng?: Rng;
  /** How a round's cards are dealt: the engine's `deal` (the default), or one that rigs the hands, for a test. */
  deal?: typeof deal;
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
  /** When the last of those changes was (ms epoch). */
  changedAt = Date.now();
  /** The authoritative round, every card known. Null in the lobby; kept through 'results'. Changed only from in here. */
  get game(): GameState | null {
    return this.state;
  }
  lastRound: RoundResult | null = null;
  /** House rules: they change only between rounds. */
  settings: TableSettings = { ...DEFAULT_SETTINGS };
  /** How many seats the table has: the host's to set, between rounds (`resize`). See `seats`. */
  private capacity = MAX_PLAYERS;
  /** Text chat, voice presence and the host's two chat switches. Never part of a snapshot. */
  readonly social = new Social();
  /** This round's snipes (see `sniped`): who, whom, and with which card. */
  private snipes: { by: number; of: number; card: string }[] = [];
  /** The last number given out to someone who began to wait for a seat (`Player.queued`), and the last `Player.id`. */
  private queue = 0;
  private ids = 0;
  private state: GameState | null = null;

  private players: Player[] = []; // everyone in the room, in the order they came
  private conns = new Map<Conn, Player>();
  /** Whoever opened the room. See `dealer` for who may actually start a round. */
  private host: Player | null = null;
  private flushScheduled = false;
  /**
   * The timer of the round's timed status, while one runs, and when it is up (ms epoch): the deal (`dealing`), the
   * "1, 2, 3" (`countdown`) or the wait for held cards once Nertz is called (`grace`); the status says which. Each is
   * set on the way into its status (`timeRound`, which calls off whatever ran before) and is gone on the way out: it
   * fired, or the round was dealt anew or is over.
   */
  private roundTimer: { handle: ReturnType<typeof setTimeout>; endsAt: number } | null = null;
  /** The last round whose start the chat was told of. */
  private startTold = 0;
  /** Who paused the round in play, if it is paused. */
  private pausedBy: Player | null = null;
  /** The round's clock: what it had run up before it was last stopped, and since when it is running now (ms epoch; null while it is not). */
  private played: number | null = null;
  private playingSince: number | null = null;
  private readonly rng: Rng;
  private readonly deal: typeof deal;
  private readonly schedule: (flush: () => void) => void;
  private readonly flipMs: number;

  constructor(
    readonly code: string,
    options: RoomOptions = {},
  ) {
    this.rng = options.rng ?? Math.random;
    this.deal = options.deal ?? deal;
    this.schedule = options.schedule ?? setImmediate;
    this.flipMs = options.flipMs ?? 0;
  }

  /** Number of live connections. */
  get connected(): number {
    return this.conns.size;
  }

  /** True when no person is in the room any more. Bots do not count. */
  get empty(): boolean {
    return !this.players.some((p) => !p.bot);
  }

  /**
   * Brings `conn` into the room, or re-attaches it to the player its token already is. Whoever is new sits down at
   * once if a seat is free and no round is being played, and otherwise comes in to watch, with a seat only by asking
   * for one (`sit`); with `sit`, they ask at once whatever the table is doing (whoever opens it).
   * Returns an error message on refusal.
   */
  join(conn: Conn, name: string, token: string, sit = false): string | null {
    if (this.conns.has(conn)) this.drop(conn, false);
    // Who someone is goes by their token alone. (A name proves nothing: anyone can type one.)
    // Whoever left is gone for good: back, they are someone new. (Only someone away comes back to their seat.)
    let player = this.players.find((p) => p.token === token && !gone(p));
    const fresh = !player;
    if (!player) {
      if (!this.room()) return 'That room is full.';
      player = { id: this.ids++, token, name, seat: null, queued: null, look: PLAIN_LOOK, score: 0, conn: null, ack: -1, dirty: false };
      this.players.push(player);
    } else if (player.conn) {
      // Same token from a second socket (duplicated tab, or a reconnect racing the old socket's close): newest wins.
      const old = player.conn;
      this.conns.delete(old);
      old.close('This seat was opened in another tab.');
      this.letGo(player); // whatever the old socket was dragging is not in this one's hand
    }
    Object.assign(player, { name, conn, ack: -1 });
    this.conns.set(conn, player);
    this.social.joined(player, this.players);
    if (fresh && (sit || (!this.roundOn && this.seatFor(player) !== null))) player.queued = ++this.queue;
    this.fill(); // a seat for them if they are waiting for one; cards, if theirs were dealt while they were away
    this.settle();
    this.changed();
    return null;
  }

  /** Any message other than `join`/`create` from a connection that has joined. Unknown connections are ignored. */
  handle(conn: Conn, msg: Exclude<ClientMsg, { t: 'join' | 'create' | 'ping' }>): void {
    const player = this.conns.get(conn);
    if (!player) return;
    switch (msg.t) {
      case 'start':
        return this.start(player);
      case 'go':
        return this.go(player);
      case 'ready': {
        const stage = this.state?.status.at;
        if ((stage !== 'dealing' && stage !== 'ready') || !this.inRound(player) || !!player.ready === msg.on) return;
        player.ready = msg.on;
        return this.changed();
      }
      case 'settings':
        return this.configure(player, msg.patch);
      case 'seats':
        return this.resize(player, msg.step);
      case 'intent':
        return this.intent(player, msg.seq, msg.intent);
      case 'drag':
        return this.dragged(player, msg);
      case 'leave':
        return this.drop(conn, true);
      case 'tried':
        return this.sniped(player, msg.card, msg.seen);
      case 'sniped':
        return;
      case 'sit': {
        // Asking for a seat, or giving it (or a place in the queue) up to watch: oneself, or whoever deals for someone else.
        // (Not someone up from their cards: until the round is over they are neither playing nor watching. See `out`.)
        const who = msg.id === undefined ? player : this.players.find((p) => p.id === msg.id);
        if (!who || who.bot || who.out || (who !== player && player !== this.dealer)) return;
        // Someone getting up from their own cards in a round under way stands, and may sit back down until it is over.
        // (Before the dealer's Start, and whoever deals standing someone else up, is for good: `upFrom`, below.)
        if (who === player && this.holds(who) && !this.unplayed) {
          if (msg.on === !who.standing) return;
          if (msg.on) delete who.standing;
          else who.standing = true;
          this.settle(); // (without their say, everyone else may now all be stuck, or all have voted)
          return this.changed();
        }
        if (msg.on) {
          if (seated(who) || who.queued !== null) return;
          who.queued = ++this.queue; // behind whoever is waiting already
        } else {
          if (!seated(who) && who.queued === null) return;
          if (seated(who) && !this.room()) return; // (no room among those watching)
          if (this.holds(who)) return this.upFrom(who, 'stood'); // up from cards of the round: see there
          who.seat = who.queued = null;
          this.social.unseated(who, this.players);
        }
        this.fill(); // a seat is theirs at once if there is one; or the one they left is someone's who was waiting
        return this.changed();
      }
      case 'host': {
        // Whoever deals may hand the table on, to a person at it: theirs from then on. (A host who stands up to watch keeps it unless they do.)
        const to = this.players.find((p) => p.id === msg.id);
        if (player !== this.dealer || !to || to.bot || to.out || !seated(to) || to === this.host) return;
        this.host = to;
        return this.changed();
      }
      case 'kick': {
        // Whoever deals may send a person away, at any time (a round in play too): wherever they are in the room, and whether they are here or away.
        const out = this.players.find((p) => p.id === msg.id);
        if (player !== this.dealer || !out || out.bot || out === player || out.out === 'kicked') return;
        const theirs = out.conn;
        if (theirs) {
          this.conns.delete(theirs);
          out.conn = null;
        }
        this.gone(out, 'kicked');
        theirs?.close('You were removed from the table by whoever deals.'); // (their window goes home, and does not come straight back)
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
        if (player !== this.dealer || this.phase !== 'playing' || !this.state) return;
        {
          // Enough to deal to? Those at the table who are here, and those waiting for whom it has a seat. (Counted before anyone is moved: a deal refused changes nothing.)
          const open = freeSeats(this.seats);
          const waiting = this.players.filter((p) => p.queued !== null && p.conn).length;
          if (this.present + Math.min(open, waiting) < MIN_PLAYERS) return;
        }
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
        if (!this.dress(bot, { ...bot.look, backs: msg.backs })) return;
        return this.changed();
      }
      case 'pause':
        return this.pause(player, msg.on);
      case 'seat':
        // A seat is a colour, and a place round the table. Only before the first deal (a round's cards go by seat), and only an empty one.
        // (Not for someone without one: a seat is theirs by asking, and by the queue.)
        if (this.phase !== 'lobby' || !seated(player) || this.players.some((p) => p.seat === msg.seat)) return;
        player.seat = msg.seat;
        return this.changed();
      case 'deck':
        if (!this.dress(player, msg.look)) return;
        return this.changed();
      default:
        return this.social.handle(player, this.players, player === this.dealer, msg);
    }
  }

  /** The socket went away. The player stays where they were and can come back with the same token. */
  disconnect(conn: Conn): void {
    this.drop(conn, false);
  }

  /** The room is being forgotten: stops its timers and its bots. */
  close(): void {
    this.stopRoundTimer();
    this.stopBots();
  }

  /** Sends every player who is owed one their latest snapshot. Runs once per event-loop turn. */
  flush(): void {
    this.flushScheduled = false;
    for (const p of this.players) {
      if (!p.dirty) continue;
      p.dirty = false;
      guard(`table ${this.code}`, () => p.conn?.send({ t: 'state', rev: this.rev, ack: p.ack, room: this.view(p) })); // (one snapshot that fails costs nobody else theirs)
    }
  }

  /** The room as the home page lists it, for anyone: see `TableSummary`. */
  summary(): TableSummary {
    return {
      code: this.code,
      names: this.table.filter(taking).map((p) => p.name),
      seats: this.capacity,
      watching: this.players.filter((p) => !seated(p) && p.conn).length,
      round: this.round,
      playing: this.phase === 'playing',
    };
  }

  // ------------------------------------------------------------ internals

  /**
   * Who may start a round: the host, or while the host has no live connection
   * the first connected player. The role returns to the host when they do
   * (a reload must not cost them the table).
   */
  private get dealer(): Player | null {
    return this.host?.conn ? this.host : (this.table.find((p) => p.conn && !p.bot) ?? this.host);
  }

  /** Table settings belong to whoever may deal, and stand still while a round is on. Anyone else is ignored. */
  private configure(player: Player, patch: Partial<TableSettings>): void {
    if (player !== this.dealer || this.phase === 'playing') return;
    this.settings = { ...this.settings, ...patch };
    this.changed();
  }

  /**
   * One seat more or fewer, for whoever may deal and between rounds, like the settings. Never fewer than are taken
   * (nobody is stood up: lowered, it only leaves fewer to be had), nor than a round needs, nor more than the table
   * seats; raised, the queue sits down.
   */
  private resize(player: Player, step: 1 | -1): void {
    if (player !== this.dealer || this.phase === 'playing') return;
    const to = Math.min(MAX_PLAYERS, Math.max(fewestSeats(this.seats), this.capacity + step));
    if (to === this.capacity) return;
    this.capacity = to;
    this.fill();
    this.changed();
  }

  private start(player: Player): void {
    // Only people who are here get cards. Someone away keeps their seat and score and sits the round out.
    if (player !== this.dealer || this.phase === 'playing' || this.present < MIN_PLAYERS) return;
    this.round++;
    this.dealOut();
  }

  /**
   * The cards of the round are dealt to everyone who is here. Also a second time, if someone sits down (or comes
   * back) after the deal but before the dealer has said Start: nothing has been played, so the round is simply
   * dealt again with them in it.
   */
  private dealOut(): void {
    // The cards of whatever round there was are gone with it. So nobody is `out` any more (that is only ever said of
    // cards in play), and with no round on the queue sits down. Done here, where a round is replaced, and in `settle`,
    // where one ends: the only two places a round goes away, so that no caller has to remember.
    this.sendOff();
    this.seatQueue();
    const dealt = this.table.filter((p) => p.conn);
    this.snipes = [];
    for (const p of this.players) delete p.ready;
    for (const p of this.players) this.draw(p); // (whoever is on a lot with nothing drawn: dealt in or not, here or away)
    this.state = this.deal(dealt.map((p) => p.seat), this.rng);
    this.phase = 'playing';
    this.pausedBy = null;
    this.played = 0; // the clock starts on the word NERTZ!
    this.playingSince = null;
    // The deal is a phase of its own: the engine refuses every intent and shows nobody a face until this fires.
    this.timeRound(DEAL_MS, () => this.dealt());
    this.changed();
  }

  /** The deal timer fired: the work piles show their tops, and the table waits (for as long as it takes) for the dealer to press Start. */
  private dealt(): void {
    if (this.phase !== 'playing' || !this.state) return;
    this.state = finishDeal(this.state);
    this.changed();
  }

  /** Whoever may deal says "1, 2, 3...": only once the cards are dealt and the table is waiting. Anyone else, any other time, is ignored. */
  private go(player: Player): void {
    if (player !== this.dealer || this.state?.status.at !== 'ready') return;
    this.state = startCountdown(this.state);
    this.timeRound(START_MS, () => this.opened());
    this.changed();
  }

  /** "...NERTZ!": play opens, and everyone's next snapshot (one flush) shows the nertz tops. */
  private opened(): void {
    if (this.phase !== 'playing' || !this.state) return;
    this.state = openPlay(this.state);
    // Told once a round, where the chat is: not again if the round is dealt over and started anew.
    if (this.startTold !== this.round) this.social.tell(this.players, { k: 'started', round: (this.startTold = this.round) });
    this.played = 0;
    this.playingSince = Date.now();
    // Play is open: the bots start looking at their cards now, like everyone else.
    for (const p of this.players) if (p.bot && this.inRound(p)) this.wake(p, true);
    this.settle();
    this.changed();
  }

  /**
   * Was `victim` sniped with `card` in hand? The one judge of it (`snipedBy`), asked of the pile at `slot` for a move
   * refused on arrival there, and of every pile for a card its window put back, wherever it was let go (`seen`: each
   * pile's top when the card was taken up). Counted once for each card that did it, shown with the round's scores, and
   * told to everyone in the room at once, and where the chat is.
   */
  private sniped(victim: Player, card: string, seen: (string | null)[], at?: number): void {
    if (this.phase !== 'playing' || !this.state || !taking(victim)) return;
    const { state } = this;
    const judge = (i: number) => snipedBy(state, victim.seat, card, i, seen[i] ?? null);
    const slot = at ?? state.slots.findIndex((_, i) => judge(i));
    const snipe = slot < 0 ? null : judge(slot);
    if (!snipe || this.snipes.some((s) => s.of === victim.seat && s.card === snipe.card)) return;
    this.snipes.push({ by: snipe.by, of: victim.seat, card: snipe.card });
    const msg: ServerMsg = { t: 'snipe', by: snipe.by, of: victim.seat, slot };
    for (const p of this.players) p.conn?.send(msg);
    const by = this.players.find((p) => p.seat === snipe.by);
    if (by) this.social.tell(this.players, { k: 'sniped', by: named(by), of: named(victim) });
  }

  /** Every timer the room sets: `fn` runs in `ms`, guarded (see server/guard.ts), and the timer never holds the process open. */
  private later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => guard(`table ${this.code}`, fn), ms);
    timer.unref?.();
    return timer;
  }

  /** The round's timed status lasts `ms`, then `fn` moves it on. Whatever was timed before is called off. */
  private timeRound(ms: number, fn: () => void): void {
    this.stopRoundTimer();
    this.roundTimer = {
      endsAt: Date.now() + ms,
      handle: this.later(ms, () => {
        this.roundTimer = null; // (a timer called off never fires: one that fires is this one)
        fn();
      }),
    };
  }

  private stopRoundTimer(): void {
    if (this.roundTimer) clearTimeout(this.roundTimer.handle);
    this.roundTimer = null;
  }

  private intent(player: Player, seq: number, intent: Extract<ClientMsg, { t: 'intent' }>['intent']): void {
    if (seq <= player.ack) return; // duplicate or out of order: already answered
    player.ack = seq;
    if (this.phase !== 'playing' || !this.state || (this.pausedBy && intent.k !== 'end')) return this.changed(player); // while paused, only the vote to end the round
    delete player.standing; // playing is sitting back down
    if (intent.k === 'flip' && this.flipMs > 0 && !player.bot) {
      const now = Date.now();
      if (now - (player.flipped ?? 0) < this.flipMs) return this.changed(player); // too soon after their last card: refused
      player.flipped = now;
    }
    const result = applyIntent(this.state, at(player), intent);
    if (!result.ok && intent.k === 'move' && intent.to.k === 'slot') this.sniped(player, intent.cardId, [], intent.to.i); // (a race lost on the way here)
    // A refused drop still empties the hand (see `refused`), which everyone sees and which can end the grace window.
    const next = result.ok ? result.state : refused(this.state, at(player), intent);
    if (next === this.state) return this.changed(player); // rejected: only the sender needs to hear (its ack moved)
    const called = next.status.at === 'grace' && this.state.status.at !== 'grace';
    this.state = next;
    // Nertz is called: the round waits (at most GRACE_MS) for the players the engine left in grace. This is the one way
    // into grace (bots and debugBotOut call Nertz through `intent` too), so the grace window is timed here and nowhere else.
    if (called) this.timeRound(GRACE_MS, () => this.graceExpired());
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
  private dragged(player: Player, where: { t: 'drag' } & DragAt): void {
    if (this.phase !== 'playing' || this.pausedBy || !taking(player) || this.state?.players.find((p) => p.seat === player.seat)?.holding !== where.id) return;
    const now = Date.now();
    const drags = (player.drags ??= { left: DRAG_BURST, at: now });
    drags.left = Math.min(DRAG_BURST, drags.left + ((now - drags.at) / 1000) * DRAG_RATE);
    drags.at = now;
    if (drags.left < 1) return;
    drags.left--;
    const msg: ServerMsg = { t: 'drag', seat: player.seat, id: where.id, w: where.w, h: where.h, p: where.p };
    for (const p of this.players) if (p !== player) p.conn?.send(msg);
  }

  /**
   * After anything that can end the round or complete an "everyone is stuck"
   * vote. Once it is over, however it ended, it is scored.
   */
  private settle(): void {
    if (this.phase !== 'playing' || !this.state) return;
    // Who has a say in its votes: whoever plays it and is here (not anyone away, standing, or up from their cards). A
    // bot goes along with ending it. And the table is jammed when no hand that is played (here or away) can get
    // anywhere: cards lying where someone got up from them will never be moved, nor will a standing player's be unless
    // they sit back down, which a jam no longer waits for. (With nobody left playing it at all, that is at once.)
    const playing = this.table.filter(taking);
    const here = playing.filter((p) => p.conn && !p.standing);
    const played = playing.filter((p) => !p.standing);
    this.state = resolveEndVote(resolveStuck(this.state, here.map((p) => p.seat), played.map((p) => p.seat)), here.filter((p) => !p.bot).map((p) => p.seat));
    const { status } = this.state;
    // (A round ended without a call, by a jam or a vote, is over at once: nobody was in grace.)
    if (status.at !== 'over') return;
    this.stopRoundTimer();
    const caller = calledBy(this.state);
    const scores = scoreRound(this.state).map((s) => {
      const p = this.players.find((p) => p.seat === s.seat);
      const called = s.seat === caller ? 1 : 0;
      if (p) p.score += s.delta;
      if (p) p.rounds = (p.rounds ?? 0) + 1;
      if (p) p.calls = (p.calls ?? 0) + called;
      return { ...s, id: p?.id ?? -1, name: p?.name ?? '', total: p?.score ?? s.delta, rounds: p?.rounds ?? 1, calls: p?.calls ?? called, ...(p ? { look: p.look } : {}) };
    });
    const pairs = new Map<string, { by: number; of: number; n: number }>();
    for (const s of this.snipes) {
      const pair = pairs.get(`${s.by}>${s.of}`) ?? { by: s.by, of: s.of, n: 0 };
      pair.n++;
      pairs.set(`${s.by}>${s.of}`, pair);
    }
    const snipes = [...pairs.values()].sort((a, b) => b.n - a.n || a.by - b.by || a.of - b.of);
    this.lastRound = { end: status.end, scores, ...(snipes.length ? { snipes } : {}) };
    this.phase = 'results';
    this.stopClock();
    this.pausedBy = null;
    this.stopBots();
    this.sendOff();
    this.fill(); // the round is over: whoever waited for a seat sits down, as far as there are seats
    this.social.tell(this.players, roundOver(this.round, this.lastRound));
  }

  /**
   * Anyone in the round may pause it while it is being played (not once Nertz is called). Cards in hand go back, and
   * the bots stop. Anyone in the round unpauses it, and so does the dealer, who may be watching.
   */
  private pause(player: Player, on: boolean): void {
    if (!this.state || !(this.inRound(player) || (!on && player === this.dealer))) return;
    if (on) {
      if (this.pausedBy || !isLive(this.state)) return;
      this.pausedBy = player;
      this.stopClock();
      for (const p of this.players) this.letGo(p);
      this.stopBots();
    } else {
      if (!this.pausedBy) return;
      this.pausedBy = null;
      this.playingSince = Date.now();
      for (const p of this.players) if (p.bot && this.inRound(p)) this.wake(p);
    }
    this.changed();
  }

  /** The round's clock stops (a pause, or the end of the round), keeping what it has run up. */
  private stopClock(): void {
    if (this.playingSince !== null) this.played = (this.played ?? 0) + Date.now() - this.playingSince;
    this.playingSince = null;
  }

  private graceExpired(): void {
    if (this.phase !== 'playing' || !this.state) return;
    this.state = expireGrace(this.state);
    this.settle();
    this.changed();
  }

  /** The player's connection is gone, or they are getting up from their cards: a card in their hand is put back, which also cuts them off if they were in grace. */
  private letGo(player: Player): void {
    if (this.phase !== 'playing' || !this.state || !taking(player)) return;
    const result = applyIntent(this.state, at(player), { k: 'release' });
    if (result.ok) this.state = result.state;
  }

  private drop(conn: Conn, leaving: boolean): void {
    const player = this.conns.get(conn);
    if (!player) return;
    this.conns.delete(conn);
    player.conn = null;
    if (leaving) return this.gone(player, 'left');
    // Away for now: they stay where they were.
    this.letGo(player);
    this.social.left(player, this.players);
    this.settle(); // the remaining connected players may now all be stuck
    this.changed();
  }

  // ------------------------------------------------------------ who is where

  /** Those at the table, in seat order. */
  private get table(): Seated[] {
    return this.players.filter(seated).sort((a, b) => a.seat - b.seat);
  }

  /** The table's seats, and how many are taken: the one count every way of sitting down goes by (`seatFor`, a deal over, `resize`). */
  private get seats(): Seats {
    return { of: this.capacity, taken: this.players.filter(taking).length };
  }

  /** Those at the table who are here: who a deal would give cards to. (Not anyone up from their cards: they are not dealt in again.) */
  private get present(): number {
    return this.table.filter((p) => taking(p) && p.conn).length;
  }

  /** Are cards of `p`'s in a round that is not over, dealt into the one now on the table? (Played by them, or lying there: see `out`.) */
  private holds(p: Player): boolean {
    return this.phase === 'playing' && seated(p) && !!this.state?.players.some((g) => g.seat === p.seat);
  }

  /** Does `p` play the round that is on: dealt into it, and not up from their cards? (The rule is the engine's, `inRound`: the window asks it too.) */
  private inRound(p: Player): boolean {
    return this.phase === 'playing' && !!this.state && inRound(this.state, at(p));
  }

  /** Is a round being played (the count, and play)? Not: the lobby, the score sheet, or cards dealt that nobody has played yet. */
  private get roundOn(): boolean {
    const stage = this.state?.status.at;
    return stage === 'countdown' || stage === 'play' || stage === 'grace';
  }

  /** Are the cards on the table dealt, and none of them played: the deal, and the wait for the dealer's Start? */
  private get unplayed(): boolean {
    const stage = this.state?.status.at;
    return this.phase === 'playing' && (stage === 'dealing' || stage === 'ready');
  }

  /** Is there room for one more without a seat? If not, someone without one whose window is long gone gives up their place (never the host). */
  private room(): boolean {
    if (this.players.filter((p) => !seated(p)).length < MAX_WATCHERS) return true;
    const away = this.players.find((p) => !seated(p) && !p.conn && p !== this.host);
    if (away) this.remove(away);
    return !!away;
  }

  /**
   * The seat for `p` to take: the one they had in the last round if nobody has it (their colour, and their place), or
   * else the lowest free one; null when the table is full (no seat of `seats` free). A bot, new, has no last round.
   */
  private seatFor(p?: Player): number | null {
    if (freeSeats(this.seats) === 0) return null;
    const free = (seat: number) => !this.players.some((q) => q.seat === seat);
    const own = p && this.lastRound?.scores.find((l) => l.id === p.id)?.seat;
    if (own !== undefined && free(own)) return own;
    for (let seat = 0; seat < MAX_PLAYERS; seat++) if (free(seat)) return seat;
    return null;
  }

  /**
   * The one place where anyone sits down. Free seats go to those in the queue who are here, first come first (someone
   * away keeps their place in it). Not while a round is being played: then when it is over. And cards that are dealt
   * but not yet played are dealt again, if someone at the table has none: whoever sits down, or comes back, before
   * the dealer's Start is in the round.
   */
  private fill(): void {
    if (this.roundOn) return;
    this.seatQueue();
    const game = this.state;
    if (this.phase === 'playing' && game && this.present >= MIN_PLAYERS && this.table.some((p) => p.conn && !game.players.some((g) => g.seat === p.seat))) this.dealOut();
  }

  private seatQueue(): void {
    for (const p of this.players.filter((q) => q.queued !== null && q.conn).sort((a, b) => a.queued! - b.queued!)) {
      const seat = this.seatFor(p);
      if (seat === null) break;
      p.seat = seat;
      p.queued = null;
      this.host ??= p;
    }
  }

  /**
   * `p` is gone for good: they left, or were sent away. With cards in a round that is not over (theirs to play, or
   * already lying there since they stood up) they get up from them (`upFrom`); otherwise they are off the list now.
   */
  private gone(p: Player, how: 'left' | 'kicked'): void {
    if (this.holds(p)) return this.upFrom(p, how);
    this.remove(p, how === 'kicked');
    this.fill(); // a seat may be free: the first in the queue has it
    this.changed();
  }

  /**
   * The one place where anyone gets up from their cards in a round not over: stood up, left, or sent away (`out`, which
   * also says what becomes of them when it is). A card in their hand goes home first; and whoever remains may now all
   * be stuck, or all have voted to end it. Before the dealer's Start nothing has been played, so if enough remain the
   * cards are simply dealt again without them (which is a round gone: `dealOut` puts them where `out` says).
   */
  private upFrom(p: Player, how: NonNullable<Player['out']>): void {
    this.letGo(p);
    p.out = how;
    delete p.standing; // (for good, now)
    if (gone(p)) this.social.left(p, this.players);
    if (this.unplayed && this.present >= MIN_PLAYERS) return this.dealOut();
    this.fill(); // (whoever waits for a seat has the one this frees, once no round is being played)
    this.settle();
    this.changed();
  }

  /** The round is over (or dealt over): whoever got up from their cards in it is where their `out` said, now. */
  private sendOff(): void {
    for (const p of this.players.filter((q) => q.out)) {
      if (p.out === 'stood') {
        delete p.out;
        p.seat = null;
        this.social.unseated(p, this.players);
      } else this.remove(p, p.out === 'kicked');
    }
    for (const p of this.players.filter((q) => q.standing)) {
      delete p.standing;
      p.seat = null;
      this.social.unseated(p, this.players);
    }
  }

  /**
   * The one place where anyone is taken off the list. Their line of the last round stays on the score sheet as
   * theirs (it goes by who, not by seat), unless `offSheet`: a bot, or a person, that whoever deals sent away. The
   * table falls to its heir if they hosted it.
   */
  private remove(p: Player, offSheet = false): void {
    if (p.bot?.timer) clearTimeout(p.bot.timer);
    this.players = this.players.filter((q) => q !== p);
    if (offSheet && this.lastRound) this.lastRound = { ...this.lastRound, scores: this.lastRound.scores.map((l) => (l.id === p.id ? { ...l, gone: true } : l)) };
    if (this.host === p) this.host = this.heir();
    this.social.left(p, this.players);
  }

  /** Who the table falls to when its host is gone: a person at it, and one who is here if there is one. */
  private heir(): Player | null {
    const people = this.table.filter((p) => !p.bot && !p.out);
    return people.find((p) => p.conn) ?? people[0] ?? null;
  }

  // ------------------------------------------------------------ bots

  /** What a bot is at this table just now: its level, at the number of players dealt in. */
  private botNow(bot: NonNullable<Player['bot']>): { delayMs: number; observance: number } {
    return botAt(bot.level, this.state?.players.length ?? 2);
  }

  private addBot(by: Player, level: BotLevel): void {
    if (by !== this.dealer || this.phase === 'playing') return;
    const seat = this.seatFor();
    if (seat === null) return;
    const name = BOT_NAMES.find((n) => !this.players.some((p) => p.name === n)) ?? 'Bot';
    // The token contains a character no client token may: nobody can join into a bot's seat. A bot has a deck like anyone: the plain one.
    const id = this.ids++;
    this.players.push({ id, token: `bot:${id}`, name, seat, queued: null, look: PLAIN_LOOK, score: 0, conn: BOT_CONN, ack: -1, dirty: false, bot: { level, memory: freshMemory(), timer: null, pending: null } });
    this.changed();
  }

  /**
   * Starts the table over, for whoever deals and only between rounds: every score back to nothing, no round played,
   * no last round to show, and the table in its lobby again (where colours can be changed) with everyone who is still
   * sitting at it. Its rules, and everyone's cards and seats, stay as they are.
   */
  private reset(by: Player): void {
    if (by !== this.dealer || this.phase !== 'results') return;
    for (const p of this.players) {
      p.score = 0;
      delete p.rounds;
      delete p.calls;
      if (p.look.backs.k === 'lot') p.look = { ...p.look, backs: { ...p.look.backs, drawn: null } }; // a table started over draws its lots over
    }
    this.round = 0;
    this.startTold = 0;
    this.lastRound = null;
    this.state = null;
    this.phase = 'lobby';
    this.fill();
    this.social.tell(this.players, { k: 'reset', by: named(by) });
    this.changed();
  }

  /** `player`'s cards now look as `to` says (`rechosen`, for their backs); false if that is how they looked. A lot chosen while a round is on is drawn at once. */
  private dress(player: Player, to: Look): boolean {
    const was = player.look;
    const backs = rechosen(was.backs, to.backs);
    if (was.deck === to.deck && was.night === to.night && was.bare === to.bare && was.backs === backs) return false;
    player.look = { ...to, backs };
    if (this.phase === 'playing') this.draw(player);
    return true;
  }

  /** Draws `player` a back from their lot, if they are on one with nothing drawn from it yet. */
  private draw(player: Player): void {
    const { backs } = player.look;
    if (backs.k !== 'lot' || backs.drawn) return;
    player.look = { ...player.look, backs: { ...backs, drawn: anotherBack(undefined, backPool(backs.lot), this.rng()) } };
  }

  private removeBot(by: Player, seat: number): void {
    const player = this.players.find((p) => p.seat === seat);
    if (by !== this.dealer || this.phase === 'playing' || !player?.bot) return;
    this.remove(player, true); // (its line of the last round stays for the cards it left on the table, but off the score sheet: a bot sent away is gone)
    this.fill(); // its seat is free: the first in the queue has it
    this.changed();
  }

  /**
   * Schedules the bot's next look, a human-ish pause from now: its level's mean delay, half to one and a half times.
   * In the middle of dealing a group (`dealing`), the next card instead follows at the same quick step for everyone.
   * `fresh`: a new round, which the bot starts with nothing remembered and nothing in hand.
   */
  private wake(player: Player, fresh = false, dealing = false, spent = 0): void {
    const bot = player.bot!;
    if (fresh) {
      bot.memory = freshMemory();
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
    bot.timer = this.later(dealing ? DEAL_STEP_MS : (reflex ?? Math.max(FLIGHT_STEP_MS, think - spent)), () => this.look(player));
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
    if (this.phase !== 'playing' || !this.state || this.pausedBy) return;
    let midGroup = false;
    if (bot.pending) {
      const before = this.state;
      const { intent, memory } = bot.pending;
      // The table moved on while it was making up its mind and the move it meant to make is gone (someone took the
      // pile): it does not go through the motions of a move it can see is lost. It thinks again, briefly.
      if (intent.k === 'move' && !applyIntent(before, at(player), intent).ok) return this.rethink(player);
      if (intent.k === 'move' && flightFrames(before, at(player), intent).length > 0) return this.fly(player);
      bot.pending = null;
      this.intent(player, player.ack + 1, intent);
      if (this.state !== before) {
        bot.memory = memory;
        // It dealt a card off the stock and the group isn't finished: the rest of it comes at the common deal speed.
        midGroup = intent.k === 'flip' && (this.state.players.find((p) => p.seat === at(player))?.dealt ?? 0) > 0;
      }
    }
    this.decide(player, midGroup);
  }

  /** The bot looks the table over and picks its next action, done after a pause (less `spent`: time already gone on a move). */
  private decide(player: Player, midGroup = false, spent = 0): void {
    const bot = player.bot!;
    if (this.phase !== 'playing' || !this.state) return;
    bot.pending = chooseIntent(viewFor(this.state, at(player)), at(player), bot.memory, this.rng, this.botNow(bot).observance);
    this.wake(player, false, midGroup && bot.pending?.intent.k === 'flip', spent);
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
    const before = this.state!;
    this.intent(player, player.ack + 1, { k: 'hold', cardId: intent.cardId });
    if (this.state === before) {
      bot.pending = null; // it could not pick that card up any more
      return this.decide(player);
    }
    const frames = flightFrames(this.state!, at(player), intent);
    let i = 0;
    const step = () => {
      bot.timer = null;
      const game = this.state;
      if (this.phase !== 'playing' || !game || this.pausedBy) return;
      if (game.players.find((p) => p.seat === at(player))?.holding !== intent.cardId) {
        bot.pending = null; // taken out of its hand (the grace window closed): start afresh
        return this.decide(player);
      }
      const frame = frames[i++];
      if (frame) {
        const msg: ServerMsg = { t: 'drag', seat: at(player), ...frame };
        for (const p of this.players) p.conn?.send(msg);
        bot.timer = this.later(FLIGHT_STEP_MS, step);
        return;
      }
      bot.pending = null;
      const lands = applyIntent(game, at(player), intent).ok; // (a refused drop changes the table too: the card goes home)
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
    if (process.env.NODE_ENV === 'production' || by !== this.dealer || this.pausedBy || !this.state || !isLive(this.state)) return;
    const bot = this.players.find((p) => p.bot && this.state!.players.some((g) => g.seat === p.seat));
    if (!bot?.bot) return;
    if (bot.bot.timer) clearTimeout(bot.bot.timer);
    bot.bot.timer = null;
    bot.bot.pending = null;
    this.state = { ...this.state, players: this.state.players.map((g) => (g.seat === bot.seat ? { ...g, holding: null, nertz: [], stock: [...g.nertz, ...g.stock] } : g)) };
    this.intent(bot, bot.ack + 1, { k: 'nertz' });
  }

  /** The bot's plan came to nothing before it acted on it: it picks another and acts on that after a short pause, not a whole one. */
  private rethink(player: Player): void {
    const bot = player.bot!;
    bot.pending = chooseIntent(viewFor(this.state!, at(player)), at(player), bot.memory, this.rng, this.botNow(bot).observance);
    if (bot.timer) clearTimeout(bot.timer);
    bot.timer = this.later(RETHINK_MS * (0.6 + 0.8 * this.rng()), () => this.look(player));
  }

  private stopBots(): void {
    for (const p of this.players) {
      if (p.bot?.timer) clearTimeout(p.bot.timer);
      if (p.bot) p.bot.timer = null;
    }
  }

  /** Records a change: bumps rev, marks who is owed a snapshot (default everyone) and schedules one flush. */
  private changed(only?: Player): void {
    this.rev++;
    this.changedAt = Date.now();
    for (const p of only ? [only] : this.players) p.dirty = true;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.schedule(() => this.flush());
  }

  private view(you: Player): RoomView {
    const game = this.state && viewFor(this.state, at(you));
    const dealer = this.dealer;
    const hand = (p: Player) => (this.inRound(p) ? game?.players.find((g) => g.seat === p.seat) : undefined);
    const dealt = game?.status.at === 'dealing' || game?.status.at === 'ready';
    return {
      code: this.code,
      phase: this.phase,
      round: this.round,
      me: you.id,
      seat: taking(you) ? you.seat : null,
      players: [...this.table, ...this.players.filter((p) => p.queued !== null).sort((a, b) => a.queued! - b.queued!), ...this.players.filter((p) => !seated(p) && p.queued === null)].map((p) => ({
        id: p.id,
        seat: p.seat,
        name: p.name,
        connected: p.conn !== null,
        ...(p.out ? { left: true as const } : {}),
        ...(p.standing ? { standing: true as const } : {}),
        score: p.score,
        rounds: p.rounds ?? 0,
        calls: p.calls ?? 0,
        isHost: p === dealer,
        ...(dealt && (p.bot || p.ready) && hand(p) ? { ready: true } : {}),
        bot: p.bot?.level,
        ...(p.queued !== null ? { queued: true } : {}),
        look: p.look,
      })),
      settings: this.settings,
      seats: this.seats,
      game,
      timerMs: this.roundTimer ? Math.max(0, this.roundTimer.endsAt - Date.now()) : null,
      clock: this.played === null ? null : { ms: this.played + (this.playingSince === null ? 0 : Date.now() - this.playingSince), running: this.playingSince !== null },
      paused: this.pausedBy ? { by: this.pausedBy.id } : null,
      lastRound: this.lastRound,
    };
  }
}
