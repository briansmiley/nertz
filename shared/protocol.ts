// Wire protocol (JSON over one websocket) and inbound validation.
import type { Intent, PileRef, RoomView } from './types';

export type ClientMsg =
  /** Open a new table; the server picks the code and answers with the first snapshot (`room.code`). */
  | { t: 'create'; name: string; token: string }
  /** Sit down at (or reconnect to) an existing table. An unknown code is an error. */
  | { t: 'join'; room: string; name: string; token: string }
  | { t: 'start' }
  | { t: 'intent'; seq: number; intent: Intent }
  | { t: 'leave' };

export type ServerMsg =
  /** Full snapshot. `rev` rises on every room change; `ack` is the highest intent seq processed from this client. */
  | { t: 'state'; rev: number; ack: number; room: RoomView }
  | { t: 'error'; message: string };

export const MAX_MESSAGE_BYTES = 2048;
export const MAX_NAME_LENGTH = 20;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;
export const WORK_PILES = 4;
/** Centre slots per player in the round. */
export const SLOTS_PER_PLAYER = 4;
/** How long a player who was holding a card when Nertz was called has to put it down. */
export const GRACE_MS = 4000;
/** How long the deal at the start of a round takes. Nobody can play, or see a face, until it is over. */
export const DEAL_MS = 3000;

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

const isIndex = (v: unknown, below: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < below;
const MAX_SLOTS = SLOTS_PER_PLAYER * MAX_PLAYERS;
/** The longest run there is: King down to Ace. */
const MAX_RUN = 13;

function parsePileRef(raw: unknown): PileRef | null {
  if (!isObj(raw)) return null;
  if (raw.k === 'work') return isIndex(raw.i, WORK_PILES) ? { k: 'work', i: raw.i } : null;
  if (raw.k === 'slot') return isIndex(raw.i, MAX_SLOTS) ? { k: 'slot', i: raw.i } : null;
  return null;
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
    case 'leave':
      return { t: 'leave' };
    case 'intent': {
      const intent = parseIntent(v.intent);
      if (!Number.isSafeInteger(v.seq) || (v.seq as number) < 0 || !intent) return null;
      return { t: 'intent', seq: v.seq as number, intent };
    }
    default:
      return null;
  }
}
