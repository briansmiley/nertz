// Wire protocol (JSON over one websocket) and inbound validation.
import type { Intent, PileRef, RoomView } from './types';

export type ClientMsg =
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

function parsePileRef(raw: unknown): PileRef | null {
  if (!isObj(raw)) return null;
  switch (raw.k) {
    case 'work':
      return Number.isInteger(raw.i) && (raw.i as number) >= 0 && (raw.i as number) < WORK_PILES
        ? { k: 'work', i: raw.i as number }
        : null;
    case 'foundation':
      return isId(raw.id) ? { k: 'foundation', id: raw.id } : null;
    case 'newFoundation':
      return { k: 'newFoundation' };
    default:
      return null;
  }
}

/** Returns a clean copy of a well-formed intent, or null. Never throws. */
export function parseIntent(raw: unknown): Intent | null {
  if (!isObj(raw)) return null;
  switch (raw.k) {
    case 'move': {
      const to = parsePileRef(raw.to);
      return isId(raw.cardId) && to ? { k: 'move', cardId: raw.cardId, to } : null;
    }
    case 'flip':
      return { k: 'flip' };
    case 'stuck':
      return typeof raw.on === 'boolean' ? { k: 'stuck', on: raw.on } : null;
    case 'nertz':
      return { k: 'nertz' };
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
    case 'join': {
      if (typeof v.room !== 'string' || typeof v.name !== 'string' || typeof v.token !== 'string') return null;
      if (v.name.length > 200) return null;
      const room = v.room.trim().toUpperCase();
      const name = cleanName(v.name);
      if (!isRoomCode(room) || !name || !TOKEN_RE.test(v.token)) return null;
      return { t: 'join', room, name, token: v.token };
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
