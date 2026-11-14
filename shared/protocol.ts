// Wire protocol (JSON over one websocket) and inbound validation.
import { parseSocialMsg, type SocialClientMsg, type SocialServerMsg } from './chat';
import { parseSettings, type TableSettings } from './settings';
import { TABLE } from './table';
import type { BotLevel, Intent, PileRef, RoomView } from './types';

/**
 * The card faces there are to choose from (client/cards/Face.tsx): this project's own, large print, one with faces on
 * its suit marks, and a traditional deck of picture files. Any of them can also be had dark (`night`): light on a
 * dark card. Where a deck is named for drawing, a dark one is its name with `:night` after it. (Every deck keeps the usual two colours: everyone sees everyone's cards, and a
 * suit must not be one colour in your hand and another in your neighbour's.)
 */
export const DECKS = { modern: 'Nertz', big: 'Big print', cute: 'Cute', pixel: 'Pixel', classic: 'Classic' } as const;
export type Deck = keyof typeof DECKS;
export const isDeck = (v: unknown): v is Deck => typeof v === 'string' && Object.hasOwn(DECKS, v);

/**
 * The backs there are to choose from (drawn by `backOf` in client/cards/Face.tsx; where each is from: CREDITS.md). The
 * plain cross-hatch; patterns drawn in code; patterns of one colour, each a single picture printed in the player's own colour; and pictures
 * with colours of their own, framed in the player's colour.
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
  sunburst: 'Sunburst',
  'penrose-triangle': 'Penrose',
  blocks: 'Blocks',
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
  'tarot-star-tint': 'Medallion',
  'tarot-eye-tint': 'Vision',
} as const;
export type Back = keyof typeof CARD_BACKS;
/**
 * A back can be had without its white edge (`bare`): what is inside the edge is drawn larger, out to the edge of the
 * card. Where a back is named for drawing, such a one is its name with `:bare` after it (as a dark deck has `:night`).
 */
/** A deck as it is named for drawing: its name, with `:night` after it for the dark one. */
export const deckNamed = (deck: Deck, night: boolean | undefined): string => `${deck}${night ? ':night' : ''}`;
export const backNamed = (back: Back | undefined, bare: boolean | undefined): string | undefined => (bare ? `${back ?? 'plain'}:bare` : back);
/** The backs by kind, as they are shown to choose among (the gallery, your settings). One left out of every group is shown last, under "Other". */
export const BACK_GROUPS: readonly { name: string; backs: readonly Back[] }[] = [
  { name: 'Patterns', backs: ['plain', 'key', 'braid', 'loops', 'chain', 'waves', 'flow', 'rings', 'bubbles', 'flower-of-life'] },
  { name: 'Tilings', backs: ['check', 'diamonds', 'herringbone', 'honeycomb', 'starcross', 'houndstooth', 'shards', 'pinwheel', 'mosaic', 'flowers', 'voronoi', 'mondrian', 'penrose', 'hat-lines', 'hat-two', 'hat', 'bathroom', 'blocks'] },
  { name: 'Maths', backs: ['hilbert', 'tree', 'dragon', 'koch', 'mandelbrot', 'walk', 'life', 'pulsar', 'penrose-triangle'] },
  { name: 'Plants', backs: ['acanthus', 'fern', 'ginkgo', 'ginkgo-ring', 'ginkgo-scatter', 'fronds', 'daisy', 'tulip', 'poppies', 'rose', 'iris', 'lily', 'sunflower', 'thistle', 'waterlily', 'lotus', 'lilypads', 'oak', 'maple', 'dandelion-1', 'sequoia'] },
  { name: 'Ornate', backs: ['guilloche', 'bicycle', 'ornate', 'rosette', 'piatnik', 'atlas', 'lion', 'cobble', 'stars', 'carpet-tint', 'tarot-star-tint', 'tarot-eye-tint'] },
  { name: 'Emblems', backs: ['compass', 'lightcone', 'arbor', 'fleur', 'giglio'] },
  { name: 'Celestial', backs: ['mystic-day', 'sunburst', 'mystic-sun', 'mystic-moons', 'mystic-star', 'mystic-eye'] },
];
/**
 * A lot: backs to draw one from by chance, in place of a back of one's own choosing: once for a table, when its first
 * round is dealt (or the first after the lot was chosen), and kept there for every round after. 'all' is every back;
 * otherwise the name of a kind (a group above, or "Other" if there are backs in none: `backGroups`). Until it is drawn, such a player's back is shown as `ANY_BACK`: a
 * card with a question mark.
 */
export const isLot = (v: unknown): v is string => typeof v === 'string' && (v === 'all' || backGroups().some((g) => g.name === v));
export const backPool = (lot: string): readonly Back[] => backGroups().find((g) => g.name === lot)?.backs ?? (Object.keys(CARD_BACKS) as Back[]);
/** What a back not yet drawn is called where backs are named for drawing. */
export const ANY_BACK = 'any';

/** `BACK_GROUPS`, with any back that is in none of them gathered at the end. */
export function backGroups(): { name: string; backs: Back[] }[] {
  const seen = new Set(BACK_GROUPS.flatMap((g) => g.backs));
  const rest = (Object.keys(CARD_BACKS) as Back[]).filter((b) => !seen.has(b));
  return [...BACK_GROUPS.map((g) => ({ name: g.name, backs: [...g.backs] })), ...(rest.length ? [{ name: 'Other', backs: rest }] : [])];
}
export const isBack = (v: unknown): v is Back => typeof v === 'string' && Object.hasOwn(CARD_BACKS, v);

export type ClientMsg =
  /** Open a new table; the server picks the code and answers with the first snapshot (`room.code`). */
  | { t: 'create'; name: string; token: string }
  /** Sit down at (or reconnect to) an existing table. An unknown code is an error. */
  | { t: 'join'; room: string; name: string; token: string }
  | { t: 'start' }
  /** Dealer only, once the cards are dealt and the table is waiting (`game.stage` is `ready`): count "1, 2, 3, Nertz!" and open play. */
  | { t: 'go' }
  /** Host only, between rounds: change some table settings. They apply from the next deal. */
  | { t: 'settings'; patch: Partial<TableSettings> }
  | { t: 'intent'; seq: number; intent: Intent }
  | { t: 'leave' }
  /** Whoever deals, between rounds: start over. Everyone's score goes back to nothing and the table to its lobby, as before the first deal. */
  | { t: 'reset' }
  /** For trying things out, refused by a server in production: make a bot go out now (its nertz pile is put under its stock, and it calls). */
  | { t: 'debugBotOut' }
  /** Whoever deals, during a round: deal it over. Nothing of it is scored, and everyone who is at the table now is dealt in. */
  | { t: 'redeal' }
  /** Pause the round for everyone (on), or carry on (off). */
  | { t: 'pause'; on: boolean }
  /** Which card faces I play with: everyone sees the cards of my deck drawn that way. */
  | { t: 'deck'; deck: Deck; back?: Back; night?: boolean; bare?: boolean; lot?: string | null }
  /** Host only, between rounds: seat a bot, or send the bot in `seat` away. */
  | { t: 'addBot'; level: BotLevel }
  | { t: 'removeBot'; seat: number }
  /** I let a card go over the pile at `slot` and it was too late: someone else's very same card had just been put there. (Counted, if the table agrees.) */
  | { t: 'sniped'; slot: number }
  /** Whoever deals: send the person in `seat` away from the table. */
  | { t: 'kick'; seat: number }
  /** Whoever deals: what the bot in `seat` is called. */
  | { t: 'botName'; seat: number; name: string }
  /** Host only: the back the bot in `seat` plays with, or the lot it is drawn from, once for the table (`lot`; null: no lot, the back it has). */
  | { t: 'botBack'; seat: number; back?: Back; lot?: string | null }
  /** In the lobby: move to another seat nobody has, which is to take its colour. */
  | { t: 'seat'; seat: number }
  /** Cosmetic: where the card I am dragging is right now. Forwarded to the others, never stored. */
  | ({ t: 'drag' } & DragAt)
  /** Text chat, the host's chat switches, voice presence and WebRTC signalling: see chat.ts. */
  | SocialClientMsg;

export type ServerMsg =
  /** Full snapshot. `rev` rises on every room change; `ack` is the highest intent seq processed from this client. */
  | { t: 'state'; rev: number; ack: number; room: RoomView }
  | { t: 'error'; message: string }
  /** Whoever deals has sent you away from the table: the connection is closed next, and is not to be made again. */
  | { t: 'removed' }
  /** The card in `seat`'s hand is here now. Not a move: the card lands only with a snapshot. */
  | ({ t: 'drag'; seat: number } & DragAt)
  | SocialServerMsg;

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
 * - `w`: how far it has come of the way to a pile in the middle that would
 *   take it, from 0 (it has just left its own pile, or there is no such pile:
 *   an Ace above all) to 1 (it is over that pile). A window draws the card
 *   that far along the line from that player's hand, wherever the window
 *   seats them, to the pile (`aloftAt` in client/layout.ts, which also says
 *   how a card with no pile to go by gets to `p`).
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

export const MAX_MESSAGE_BYTES = 2048;
export const MAX_NAME_LENGTH = 20;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10; // (more than six is new: the table was drawn for six, and is laid out more tightly beyond)
export const WORK_PILES = 4;
/** Centre slots per player in the round. */
export const SLOTS_PER_PLAYER = 4;
/** How long a player who was holding a card when Nertz was called has to put it down. */
export const GRACE_MS = 4000;
/** How long the deal at the start of a round takes. Nobody can play, or see a face, until it is over. */
export const DEAL_MS = 3000;
/**
 * Dealing from the stock takes time, as it does with real cards: one click starts a group of three, and the cards
 * come off the stock one at a time, this far apart. The next group cannot start sooner than this after the last card.
 */
export const STOCK_CARD_MS = 170;
/**
 * The beat a completed group is held, counted off and still face-down, before it turns over onto the waste. Only how
 * it is drawn: the server has turned the group up already. Two gaps and the beat are the half second a group takes.
 */
export const STOCK_TURN_MS = 160;
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
const round3 = (v: number): number => Math.round(v * 1000) / 1000 || 0;
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
  return isId(v.id) && isCoord(v.w, 1) && v.w >= 0 && h && p ? { id: v.id, w: round3(v.w), h, p } : null;
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
    case 'flip':
      return { k: 'flip' };
    case 'stuck':
      return typeof raw.on === 'boolean' ? { k: 'stuck', on: raw.on } : null;
    case 'end':
      return typeof raw.on === 'boolean' ? { k: 'end', on: raw.on } : null;
    case 'nertz':
      return { k: 'nertz' };
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
    case 'start':
      return { t: 'start' };
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
    case 'pause':
      return typeof v.on === 'boolean' ? { t: 'pause', on: v.on } : null;
    case 'deck':
      return isDeck(v.deck) ? { t: 'deck', deck: v.deck, ...(isBack(v.back) ? { back: v.back } : {}), ...(typeof v.night === 'boolean' ? { night: v.night } : {}), ...(typeof v.bare === 'boolean' ? { bare: v.bare } : {}), ...(v.lot === null || isLot(v.lot) ? { lot: v.lot } : {}) } : null;
    case 'addBot': {
      const level = v.level === undefined ? 'medium' : BOT_LEVELS.find((l) => l === v.level);
      return level ? { t: 'addBot', level } : null;
    }
    case 'removeBot':
      return isIndex(v.seat, MAX_PLAYERS) ? { t: 'removeBot', seat: v.seat } : null;
    case 'sniped':
      return isIndex(v.slot, MAX_SLOTS) ? { t: 'sniped', slot: v.slot } : null;
    case 'kick':
      return isIndex(v.seat, MAX_PLAYERS) ? { t: 'kick', seat: v.seat } : null;
    case 'botName': {
      const name = typeof v.name === 'string' && v.name.length <= 200 ? cleanName(v.name) : '';
      return isIndex(v.seat, MAX_PLAYERS) && name ? { t: 'botName', seat: v.seat, name } : null;
    }
    case 'botBack':
      return isIndex(v.seat, MAX_PLAYERS) && (isBack(v.back) || v.lot === null || isLot(v.lot)) ? { t: 'botBack', seat: v.seat, ...(isBack(v.back) ? { back: v.back } : {}), ...(v.lot === null || isLot(v.lot) ? { lot: v.lot } : {}) } : null;
    case 'seat':
      return isIndex(v.seat, MAX_PLAYERS) ? { t: 'seat', seat: v.seat } : null;
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
