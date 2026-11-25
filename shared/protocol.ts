// Wire protocol (JSON over one websocket) and inbound validation.
import { parseSocialMsg, type SocialClientMsg, type SocialServerMsg, isId as isPlayerId } from './chat';
import { parseSettings, type TableSettings } from './settings';
import { TABLE } from './table';
import type { BotLevel, Intent, PileRef, PlayerView, RoomView, Seats } from './types';
import { round3 } from './numbers';

/**
 * The card faces there are to choose from (client/cards/Face.tsx): this project's own, large print, one with faces on
 * its suit marks, and a traditional deck of picture files. Any of them can also be had dark (`Look.night`): light on a
 * dark card. (Every deck keeps the usual two colours: everyone sees everyone's cards, and a
 * suit must not be one colour in your hand and another in your neighbour's.)
 */
export const DECKS = { modern: 'Nertz', big: 'Big print', classic: 'Classic', pixel: 'Pixel', cute: 'Cute' } as const;
export type Deck = keyof typeof DECKS;
export const isDeck = (v: unknown): v is Deck => typeof v === 'string' && Object.hasOwn(DECKS, v);

/**
 * The backs there are to choose from (drawn by `backOf` in client/cards/Face.tsx; where each is from: CREDITS.md). The
 * plain cross-hatch; patterns drawn in code; and patterns of one colour, each a single picture printed in the player's own colour.
 */
export const CARD_BACKS = {
  plain: 'Plain',
  // Drawn in code (client/cards/backArt.ts):
  hilbert: 'Hilbert',
  key: 'Greek key',
  braid: 'Braids',
  loops: 'Loops',
  rings: 'Rings',
  guilloche: 'Guilloche',
  voronoi: 'Voronoi',
  bubbles: 'Circles',
  tree: 'Binary',
  dragon: 'Dragon',
  koch: 'Koch',
  mandelbrot: 'Mandelbrot',
  walk: 'Walk',
  mondrian: 'Mondrian',
  diamonds: 'Diamond tile',
  herringbone: 'Herringbone',
  honeycomb: 'Hexes',
  starcross: 'Starcrossed',
  houndstooth: 'Houndstooth',
  shards: 'Shards',
  pinwheel: 'Pinwheel',
  mosaic: 'Mosaic',
  flowers: 'Flowers',
  compass: 'Compass',
  lightcone: 'Lightcone',
  arbor: 'Arbor',
  earth: 'Earth',
  fleur: 'Fleur-de-lis',
  giglio: 'Florence',
  lotus: 'Lotus',
  'flower-of-life': 'Flower',
  'mystic-moons': 'Moons',
  'mystic-sun': 'Moon',
  'mystic-eye': 'Eye',
  'mystic-day': 'Sun',
  'mystic-star': 'Star',
  bathroom: 'Tiles',
  corridor: 'Hexes',
  overlook: 'Overlook',
  frames: 'Frames',
  facets: 'Facets',
  hatch: 'Hatch',
  sunburst: 'Sunburst',
  'penrose-triangle': 'Penrose',
  blocks: 'Blocks',
  fans: 'Fans',
  tripods: 'Tripods',
  paisley: 'Paisley',
  sashiko: 'Sashiko',
  waves: 'Waves',
  flow: 'Flow',
  life: 'Life',
  penrose: 'Rhombs',
  hat: 'Einstein 3',
  // (Three renditions of the hat tiling: outlines only, the turned-over hats white, and those with the hats round them shaded.)
  'hat-two': 'Einstein 2',
  'hat-lines': 'Einstein 1',
  chain: 'Chain',
  pulsar: 'Pulsar',
  // Pictures (public/cards/backs):
  bicycle: 'Rider',
  ornate: 'Ornate',
  rosette: 'Rosette',
  cobble: 'Cobble',
  stars: 'Stars',
  lion: 'Lion',
  piatnik: 'Piatnik',
  atlas: 'Atlas',
  check: 'Check',
  'carpet-tint': 'Carpet',
  // Made by the owner in Midjourney: in their own colours, and as one-colour prints of the same pictures.
  acanthus: 'Acanthus',
  fern: 'Fern',
  ginkgo: 'Ginkgo',
  'ginkgo-ring': 'Ginkgo ring',
  'ginkgo-scatter': 'Ginkgos',
  fronds: 'Fronds',
  daisy: 'Daisy',
  tulip: 'Tulip',
  oak: 'Oak',
  thistle: 'Thistle',
  clover: 'Clover',
  'clover-2': 'Clover 2',
  lily: 'Lily',
  rose: 'Rose',
  iris: 'Iris',
  sunflower: 'Sunflower',
  waterlily: 'Water lily',
  lilypads: 'Lily pads',
  maple: 'Maple',
  'dandelion-1': 'Dandelion',
  poppies: 'Poppies',
  sequoia: 'Sequoia',
  birch: 'Birch',
  fox: 'Fox',
  owl: 'Owl',
  loong: 'Loong',
  rabbit: 'Rabbit',
  crane: 'Crane',
  phoenix: 'Phoenix',
  deer: 'Deer',
  koi: 'Koi',
  falcon: 'Falcon',
  swallowtail: 'Swallowtail',
  butterflies: 'Butterflies',
  ants: 'Ants',
  aster: 'Aster',
  'tarot-star-tint': 'Medallion',
  'tarot-eye-tint': 'Vision',
} as const;
export type Back = keyof typeof CARD_BACKS;
/** The backs by kind, as they are shown to choose among (the gallery, your settings). One left out of every group is shown last, under "Other". */
export const BACK_GROUPS: readonly { name: string; backs: readonly Back[] }[] = [
  { name: 'Patterns', backs: ['plain', 'key', 'braid', 'loops', 'chain', 'waves', 'flow', 'rings', 'bubbles', 'flower-of-life', 'paisley', 'sashiko', 'stars', 'fleur'] },
  { name: 'Tilings', backs: ['check', 'diamonds', 'herringbone', 'honeycomb', 'starcross', 'houndstooth', 'shards', 'pinwheel', 'mosaic', 'flowers', 'voronoi', 'mondrian', 'penrose', 'hat-lines', 'hat-two', 'hat', 'bathroom', 'corridor', 'overlook', 'frames', 'facets', 'hatch', 'blocks', 'fans', 'tripods'] },
  { name: 'Maths', backs: ['hilbert', 'tree', 'dragon', 'koch', 'mandelbrot', 'walk', 'life', 'pulsar', 'penrose-triangle'] },
  { name: 'Plants', backs: ['acanthus', 'fern', 'ginkgo', 'ginkgo-ring', 'ginkgo-scatter', 'fronds', 'daisy', 'tulip', 'poppies', 'rose', 'iris', 'lily', 'sunflower', 'thistle', 'clover', 'clover-2', 'waterlily', 'lotus', 'lilypads', 'oak', 'maple', 'dandelion-1', 'sequoia', 'birch'] },
  { name: 'Ornate', backs: ['guilloche', 'bicycle', 'ornate', 'rosette', 'piatnik', 'atlas', 'lion', 'cobble', 'carpet-tint', 'tarot-star-tint', 'tarot-eye-tint'] },
  { name: 'Animals', backs: ['fox', 'owl', 'loong', 'rabbit', 'crane', 'phoenix', 'deer', 'koi', 'falcon', 'swallowtail', 'butterflies', 'ants', 'aster'] },
  { name: 'Emblems', backs: ['compass', 'lightcone', 'arbor', 'giglio', 'earth'] },
  { name: 'Celestial', backs: ['mystic-day', 'sunburst', 'mystic-sun', 'mystic-moons', 'mystic-star', 'mystic-eye'] },
];
/**
 * A lot: backs to draw one from by chance, in place of a back of one's own choosing: once for a table, when its first
 * round is dealt (or the first after the lot was chosen), and kept there for every round after. 'all' is every back;
 * otherwise the name of a kind (a group above, or "Other" if there are backs in none: `backGroups`). Until it is drawn, such a player's back is shown as a
 * card with a question mark.
 */
export type Lot = string;
export const isLot = (v: unknown): v is Lot => typeof v === 'string' && (v === 'all' || backGroups().some((g) => g.name === v));
export const backPool = (lot: Lot): readonly Back[] => backGroups().find((g) => g.name === lot)?.backs ?? (Object.keys(CARD_BACKS) as Back[]);

/**
 * Where a player's backs come from: their own choice, or a lot. A back is drawn from a lot once for the table and kept
 * for every round there: `drawn` is null until it is, which is at the next deal, or at once if a round is on. Only
 * the table draws: a lot said by a client is always undrawn.
 */
export type Backs = { k: 'own'; back: Back } | { k: 'lot'; lot: Lot; drawn: Back | null };
/** The back `backs` come to: null for a lot not drawn yet (a card with a question mark). */
export const shownBack = (backs: Backs): Back | null => (backs.k === 'own' ? backs.back : backs.drawn);
/**
 * How a player's cards look, for everyone: their faces (`deck`, dark if `night`) and their backs (`bare`: without the
 * white edge, what is inside it drawn larger, out to the edge of the card).
 */
export interface Look {
  deck: Deck;
  night: boolean;
  backs: Backs;
  bare: boolean;
}
/** The look of a bot's cards, and of anyone's until they say theirs. */
export const PLAIN_LOOK: Look = { deck: 'modern', night: false, backs: { k: 'own', back: 'plain' }, bare: false };

/** `BACK_GROUPS`, with any back that is in none of them gathered at the end. */
export function backGroups(): { name: string; backs: Back[] }[] {
  const seen = new Set(BACK_GROUPS.flatMap((g) => g.backs));
  const rest = (Object.keys(CARD_BACKS) as Back[]).filter((b) => !seen.has(b));
  return [...BACK_GROUPS.map((g) => ({ name: g.name, backs: [...g.backs] })), ...(rest.length ? [{ name: 'Other', backs: rest }] : [])];
}
export const isBack = (v: unknown): v is Back => typeof v === 'string' && Object.hasOwn(CARD_BACKS, v);
/**
 * A back drawn by chance from `pool` (all of them, unless a lot is given), never `had` while the pool has another:
 * what a card turned over shows (the hand on the home page), and a player's draw from their lot. `roll` is in [0, 1).
 */
export function anotherBack(had: Back | undefined, pool: readonly Back[] = Object.keys(CARD_BACKS) as Back[], roll: number = Math.random()): Back {
  const others = pool.length > 1 ? pool.filter((b) => b !== had) : pool;
  return others[Math.min(others.length - 1, Math.floor(roll * others.length))]!;
}

/** For trying things out (never in production): the set-up deals Start may ask for (`?deal=aces`), each dealt by `setUpDeal`. */
export const SET_UPS = ['aces', 'two-piles', 'out'] as const;
export type SetUp = (typeof SET_UPS)[number];

export type ClientMsg =
  /** Open a new table, and sit down at it; the server picks the code and answers with the first snapshot (`room.code`). */
  | { t: 'create'; name: string; token: string }
  /** Come into (or reconnect to) an existing table: to a seat if one is free and no round is being played, and else to watch, until you ask for one (`sit`). An unknown code is an error. */
  | { t: 'join'; room: string; name: string; token: string }
  /** `deal`: a set-up deal instead of a random one, refused by a server in production. */
  | { t: 'start'; deal?: SetUp }
  /** Dealer only, once the cards are dealt and the table is waiting (`game.status` is `ready`): count "1, 2, 3, Nertz!" and open play. */
  | { t: 'go' }
  /** Once the cards are dealt, before Start: I am ready (or, off, not after all). Shown to everyone; the dealer still says when. */
  | { t: 'ready'; on: boolean }
  /** Host only, between rounds: change some table settings. They apply from the next deal. */
  | { t: 'settings'; patch: Partial<TableSettings> }
  /** Host only, between rounds: one seat more (1) or fewer (-1). The server keeps the number within `fewestSeats` and `MAX_PLAYERS`, so taps sent faster than the snapshots come back each count. */
  | { t: 'seats'; step: 1 | -1 }
  | { t: 'intent'; seq: number; intent: Intent }
  | { t: 'leave' }
  /** Whoever deals, between rounds: start over. Everyone's score goes back to nothing and the table to its lobby, as before the first deal. */
  | { t: 'reset' }
  /** For trying things out, refused by a server in production: make a bot go out now (its nertz pile is put under its stock, and it calls). */
  | { t: 'debugBotOut' }
  /** Whoever deals, during a round: deal it over. Nothing of it is scored, and everyone who is at the table now is dealt in. */
  | { t: 'redeal' }
  /** Pause the round for everyone (on), or unpause it (off). */
  | { t: 'pause'; on: boolean }
  /** How my cards look: everyone sees the cards of my deck drawn that way. Every part of it is said, every time. */
  | { t: 'deck'; look: Look }
  /** Host only, between rounds: seat a bot, or send the bot in `seat` away. */
  | { t: 'addBot'; level: BotLevel }
  | { t: 'removeBot'; seat: number }
  /** I put my one card `card` back unplayed, wherever I let it go; `seen` is the top of every pile in the middle when I took the card up (null: there was no pile). The server judges whether I was sniped meanwhile (`snipedBy`). */
  | { t: 'tried'; card: string; seen: (string | null)[] }
  /** From a window older than the server's own judgement of snipes, or than a snipe counting wherever the card is let go. Ignored. */
  | { t: 'sniped' }
  /** Ask for a seat (on: it is yours at once if one is free and no round is being played, and otherwise when your turn in the queue comes), or give up your seat or your place in the queue and just watch (off): yourself, or as whoever deals the person `id`. Not out of a round you hold cards in. */
  | { t: 'sit'; on: boolean; id?: number }
  /** Whoever deals: hand the table on to the person `id` (someone at it), who hosts it from then on. */
  | { t: 'host'; id: number }
  /** Whoever deals: send the person `id` away from the table. */
  | { t: 'kick'; id: number }
  /** Whoever deals: what the bot in `seat` is called. */
  | { t: 'botName'; seat: number; name: string }
  /** Host only: the back the bot in `seat` plays with, or the lot it is drawn from, once for the table. */
  | { t: 'botBack'; seat: number; backs: Backs }
  /** In the lobby: move to another seat nobody has, which is to take its colour. */
  | { t: 'seat'; seat: number }
  /** Cosmetic: where the card I am dragging is right now. Forwarded to the others, never stored. */
  | ({ t: 'drag' } & DragAt)
  /**
   * Are you still there? Answered at once with `pong`, at a table or not (see `PING_MS`). `at` is the asker's clock as it
   * asked, handed back in the pong: the asker's time for the round trip.
   */
  | { t: 'ping'; at?: number }
  /** Text chat, the host's chat switches, voice presence and WebRTC signalling: see chat.ts. */
  | SocialClientMsg;

export type ServerMsg =
  /** Full snapshot. `rev` rises on every room change; `ack` is the highest intent seq processed from this client. */
  | { t: 'state'; rev: number; ack: number; room: RoomView }
  /** A complaint about something this connection sent. It changes nothing: the connection goes on. */
  | { t: 'error'; message: string }
  /** To everyone in the room: seat `by` has just beaten seat `of` to the pile at `slot` with the very card `of` was about to put there. */
  | { t: 'snipe'; by: number; of: number; slot: number }
  /** The card in `seat`'s hand is here now. Not a move: the card lands only with a snapshot. */
  | ({ t: 'drag'; seat: number } & DragAt)
  /** The answer to `ping`, with its `at`. */
  | { t: 'pong'; at?: number }
  | SocialServerMsg;

/**
 * A window that has heard nothing from the server for this long asks whether it is still there. A line can die without the window being told (the
 * network drops while the server gives up on the socket, or a phone moves from wifi to cellular): the socket looks open
 * and nothing ever comes down it. So a window that has heard nothing at all for `SILENT_MS` takes its line for dead and
 * reconnects, as it does when a socket says it has closed.
 */
export const PING_MS = 5_000;
export const SILENT_MS = 12_000;

/**
 * The close code of a connection the server is done with for good: refused a table, its seat opened in another tab, or
 * sent away by whoever deals. The close reason is what to tell the player (at most 123 bytes). The window goes home and
 * does not come back by itself; any other close is a dropped line, and the window reconnects.
 */
export const CLOSE_OVER = 4000;

/**
 * The close code of a connection the server closes as it stops to start anew (a deploy): the websocket's own "service
 * restart". A dropped line like any other, and the window reconnects; but it knows why, and says so meanwhile.
 */
export const CLOSE_UPDATE = 1012;

/**
 * Where a held card (the one named by the sender's `hold`) is, in two frames
 * at once, so that every window can draw it in its own picture of the table:
 * - `h`: how far its centre is from where it lay in its owner's hand, in
 *   widths of that hand's cards: [along the row of piles, towards the middle
 *   of the table]. Right near the hand, whatever size and place a window
 *   gives that hand (hands are drawn upright everywhere, so "along the row"
 *   is to the right on every screen; "towards the middle" is up the owner's
 *   screen and down, or sideways, on everyone else's).
 * - `p`: its centre in table space (shared/table.ts): the same point of the
 *   felt on every screen. Right once it is where it is going.
 * - `w`: how far along its way it is, one number: 0 where it was taken, 1 at
 *   the edge of the felt, 2 over a pile in the middle that would take it (a
 *   card with no such pile, an Ace above all, stops at 1). A window draws the
 *   card that far along one path: out from that player's hand, wherever the
 *   window seats them, to the felt's edge, and on to the pile (`aloftPath` in
 *   client/layout.ts, which also says how a card with no pile to go by gets
 *   to `p`).
 */
export interface DragAt {
  id: string;
  w: number;
  h: [number, number];
  p: [number, number];
}

/** How often a dragging client reports its card (per second), and what the server lets through per player. */
export const DRAG_HZ = 18;
export const DRAG_RATE = 30;
export const DRAG_BURST = 12;

/** The largest frame a client may send. Each message is bounded field by field in `parseClientMsg`; this is room for a voice offer in one message. */
export const MAX_MESSAGE_BYTES = 16_384;
export const MAX_NAME_LENGTH = 20;
export const MIN_PLAYERS = 2;
/** Beyond the seats, this many more may be in the room to watch (and wait for a seat). */
export const MAX_WATCHERS = 20;
/** Someone with a seat at the table (not: waiting for one, or just watching). */
export type SeatedView = PlayerView & { seat: number };
export const hasSeat = (p: PlayerView): p is SeatedView => p.seat !== null;
export const MAX_PLAYERS = 10; // (more than six is new: the table was drawn for six, and is laid out more tightly beyond)
/** How many seats are still to be had: none when as many are taken as the table has (or more, if it was lowered while they were). */
export const freeSeats = (s: Seats): number => Math.max(0, s.of - s.taken);
/** The fewest seats the table may be set to: never fewer than are taken (nobody is stood up), nor than a round needs. */
export const fewestSeats = (s: Seats): number => Math.max(MIN_PLAYERS, s.taken);
export const WORK_PILES = 4;
/** Centre slots per player in the round. */
export const SLOTS_PER_PLAYER = 4;
/** How long a player who was holding a card when Nertz was called has to put it down. */
export const GRACE_MS = 4000;
/**
 * The longest a call waits to reach a window, from when it is made (within `GRACE_MS`). A window says at once that it
 * has it, a round trip after the call; one that has not by then (asleep in the background, or on a line slower than
 * this) is taken to have, and a card it takes up from then on is too late.
 */
export const HEAR_MS = 1000;
/** How long the deal at the start of a round takes. Nobody can play, or see a face, until it is over. */
export const DEAL_MS = 3000;
/**
 * Dealing from the stock takes time, as it does with real cards: one draw deals a group of three, and its cards
 * come off the stock one at a time, this far apart, the group turning up this long after the third. So a draw takes
 * half a second, and the next can start once its group is up. The server puts the group on the waste in one step and
 * holds everyone to that time by the round's clock (`PlayerState.draw`); each window deals the cards out on its own.
 */
export const STOCK_CARD_MS = 170;
/** The dealer's "1, 2, 3, NERTZ!": one beat per number, and play opens on the word. */
export const START_BEAT_MS = 700;
export const START_BEATS = 3;
export const START_MS = START_BEAT_MS * START_BEATS;
export const BOT_LEVELS: readonly BotLevel[] = ['slow', 'medium', 'fast'];

/** No I, O (look like 1, 0). */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const ROOM_CODE_LENGTH = 4;
const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_ID_LENGTH = 64;

export const isRoomCode = (s: string): boolean => ROOM_RE.test(s);

/**
 * Where someone's page is (`Account.handle`), as it is kept: 3 to 20 lowercase letters and digits, with single hyphens
 * between them. Drawn at random until its owner claims one of their own (server/accounts.ts).
 */
export const MAX_HANDLE_LENGTH = 20;
const HANDLE_RE = new RegExp(`^(?=.{3,${MAX_HANDLE_LENGTH}}$)[a-z0-9]+(?:-[a-z0-9]+)*$`);
export const isHandle = (s: string): boolean => HANDLE_RE.test(s);
/** `s`, in any case, as the handle it is: null for none it could be. */
export const handleOf = (s: string): string | null => {
  const handle = s.toLowerCase();
  return isHandle(handle) ? handle : null;
};

export function randomRoomCode(rng: () => number = Math.random): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_ALPHABET[Math.min(ROOM_ALPHABET.length - 1, Math.floor(rng() * ROOM_ALPHABET.length))];
  }
  return code;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;

const isCoord = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max;
const isIndex = (v: unknown, below: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < below;
const MAX_SLOTS = SLOTS_PER_PLAYER * MAX_PLAYERS;
/** The longest run there is: King down to Ace. */
const MAX_RUN = 13;

function parsePileRef(raw: unknown): PileRef | null {
  if (!isObj(raw)) return null;
  if (raw.k === 'work') return isIndex(raw.i, WORK_PILES) ? { k: 'work', i: raw.i } : null;
  if (raw.k === 'slot') return isIndex(raw.i, MAX_SLOTS) ? { k: 'slot', i: raw.i } : null;
  if (raw.k === 'felt') return isCoord(raw.x, TABLE.hw) && isCoord(raw.y, 1) ? { k: 'felt', x: round3(raw.x), y: round3(raw.y) } : null;
  return null;
}

/** A clean copy of a card-position report, or null. Coordinates are bounded and rounded: nothing else is checked. */
function parseDrag(v: Record<string, unknown>): DragAt | null {
  const pair = (raw: unknown, max: number): [number, number] | null =>
    Array.isArray(raw) && raw.length === 2 && isCoord(raw[0], max) && isCoord(raw[1], max) ? [round3(raw[0]), round3(raw[1])] : null;
  const h = pair(v.h, 60);
  const p = pair(v.p, 8);
  return isId(v.id) && isCoord(v.w, 2) && v.w >= 0 && h && p ? { id: v.id, w: round3(v.w), h, p } : null;
}

/** Returns a clean copy of a well-formed intent, or null. Never throws. */
export function parseIntent(raw: unknown): Intent | null {
  if (!isObj(raw)) return null;
  switch (raw.k) {
    case 'move': {
      const to = parsePileRef(raw.to);
      const count = raw.count;
      return isId(raw.cardId) && Number.isInteger(count) && to && isIndex((count as number) - 1, MAX_RUN) ? { k: 'move', cardId: raw.cardId, count: count as number, to } : null;
    }
    case 'draw':
      return { k: 'draw' };
    case 'stuck':
      return typeof raw.on === 'boolean' ? { k: 'stuck', on: raw.on } : null;
    case 'end':
      return typeof raw.on === 'boolean' ? { k: 'end', on: raw.on } : null;
    case 'nertz': {
      const { unheard } = raw;
      if (unheard === undefined) return { k: 'nertz' };
      return Array.isArray(unheard) && unheard.length <= MAX_PLAYERS && unheard.every((s) => isIndex(s, MAX_PLAYERS)) ? { k: 'nertz', unheard: [...new Set(unheard as number[])] } : null;
    }
    case 'heard':
      return { k: 'heard' };
    case 'clear':
      return isIndex(raw.slot, MAX_SLOTS) ? { k: 'clear', slot: raw.slot } : null;
    case 'hold':
      return isId(raw.cardId) ? { k: 'hold', cardId: raw.cardId } : null;
    case 'release':
      return { k: 'release' };
    default:
      return null;
  }
}

function parseBacks(raw: unknown): Backs | null {
  if (!isObj(raw)) return null;
  if (raw.k === 'own') return isBack(raw.back) ? { k: 'own', back: raw.back } : null;
  if (raw.k === 'lot') return isLot(raw.lot) ? { k: 'lot', lot: raw.lot, drawn: null } : null;
  return null;
}

function parseLook(raw: unknown): Look | null {
  if (!isObj(raw)) return null;
  const backs = parseBacks(raw.backs);
  return isDeck(raw.deck) && typeof raw.night === 'boolean' && typeof raw.bare === 'boolean' && backs ? { deck: raw.deck, night: raw.night, backs, bare: raw.bare } : null;
}

/** Strips control characters, collapses whitespace, trims and caps length. May return ''. */
export function cleanName(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/**
 * Validates one inbound client message. Accepts either the raw JSON text or an
 * already-parsed value. Returns a normalised message (room upper-cased, name
 * cleaned, unknown fields dropped) or null for anything malformed. Never throws.
 */
export function parseClientMsg(raw: unknown): ClientMsg | null {
  let v = raw;
  if (typeof v === 'string') {
    if (v.length > MAX_MESSAGE_BYTES) return null;
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!isObj(v)) return null;
  switch (v.t) {
    case 'create':
    case 'join': {
      if (typeof v.name !== 'string' || typeof v.token !== 'string' || v.name.length > 200) return null;
      const name = cleanName(v.name);
      if (!name || !TOKEN_RE.test(v.token)) return null;
      if (v.t === 'create') return { t: 'create', name, token: v.token };
      const room = typeof v.room === 'string' ? v.room.trim().toUpperCase() : '';
      return isRoomCode(room) ? { t: 'join', room, name, token: v.token } : null;
    }
    case 'start': {
      const setUp = SET_UPS.find((s) => s === v.deal);
      return setUp ? { t: 'start', deal: setUp } : { t: 'start' };
    }
    case 'go':
      return { t: 'go' };
    case 'leave':
      return { t: 'leave' };
    case 'reset':
      return { t: 'reset' };
    case 'debugBotOut':
      return { t: 'debugBotOut' };
    case 'redeal':
      return { t: 'redeal' };
    case 'ping':
      return typeof v.at === 'number' && Number.isFinite(v.at) ? { t: 'ping', at: v.at } : { t: 'ping' };
    case 'ready':
      return typeof v.on === 'boolean' ? { t: 'ready', on: v.on } : null;
    case 'sit':
      return typeof v.on === 'boolean' && (v.id === undefined || isPlayerId(v.id)) ? { t: 'sit', on: v.on, ...(v.id === undefined ? {} : { id: v.id }) } : null;
    case 'pause':
      return typeof v.on === 'boolean' ? { t: 'pause', on: v.on } : null;
    case 'deck': {
      const look = parseLook(v.look);
      return look ? { t: 'deck', look } : null;
    }
    case 'addBot': {
      const level = v.level === undefined ? 'medium' : BOT_LEVELS.find((l) => l === v.level);
      return level ? { t: 'addBot', level } : null;
    }
    case 'removeBot':
      return isIndex(v.seat, MAX_PLAYERS) ? { t: 'removeBot', seat: v.seat } : null;
    case 'tried':
      if (isId(v.card) && isIndex(v.slot, MAX_SLOTS) && (v.seen === null || isId(v.seen))) return { t: 'sniped' }; // (an older window's: one pile only)
      return isId(v.card) && Array.isArray(v.seen) && v.seen.length <= MAX_SLOTS && v.seen.every((c) => c === null || isId(c)) ? { t: 'tried', card: v.card, seen: v.seen } : null;
    case 'sniped':
      return { t: 'sniped' };
    case 'host':
      return isPlayerId(v.id) ? { t: 'host', id: v.id } : null;
    case 'kick':
      return isPlayerId(v.id) ? { t: 'kick', id: v.id } : null;
    case 'botName': {
      const name = typeof v.name === 'string' && v.name.length <= 200 ? cleanName(v.name) : '';
      return isIndex(v.seat, MAX_PLAYERS) && name ? { t: 'botName', seat: v.seat, name } : null;
    }
    case 'botBack': {
      const backs = parseBacks(v.backs);
      return isIndex(v.seat, MAX_PLAYERS) && backs ? { t: 'botBack', seat: v.seat, backs } : null;
    }
    case 'seat':
      return isIndex(v.seat, MAX_PLAYERS) ? { t: 'seat', seat: v.seat } : null;
    case 'seats':
      return v.step === 1 || v.step === -1 ? { t: 'seats', step: v.step } : null;
    case 'settings': {
      const patch = parseSettings(v.patch);
      return patch ? { t: 'settings', patch } : null;
    }
    case 'drag': {
      const at = parseDrag(v);
      return at ? { t: 'drag', ...at } : null;
    }
    case 'intent': {
      const intent = parseIntent(v.intent);
      if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 0 || !intent) return null;
      return { t: 'intent', seq: v.seq as number, intent };
    }
    default:
      return parseSocialMsg(v);
  }
}
